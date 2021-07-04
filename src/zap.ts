import contentType from 'content-type'
import http from 'http'
import {compile, match} from 'path-to-regexp'
import getRawBody from 'raw-body'
import {Readable, Stream} from 'stream'
import type tls from 'tls'
import {URL} from 'url'

const IS_DEV = process.env.NODE_ENV === 'development'

// Types -----------------------------------------------------------------------

// See: https://developer.mozilla.org/en-US/docs/Web/HTTP/Methods (omitted CONNECT and TRACE)
export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'DELETE' | 'OPTIONS' | 'PATCH'

export interface ServerRequest<Params = unknown, RequestBody = unknown> extends Omit<http.IncomingMessage, 'url'> {
  body: RequestBody
  params: Params
  protocol: 'http' | 'https'
  url: URL
}

export interface ServerResponse extends http.ServerResponse {}

export type ResponseBodyType = string | object | number | Buffer | Stream | null
export type Next = (req: ServerRequest, res: ServerResponse) => Promise<void>
export type Handler<
  ResponseBody extends ResponseBodyType = ResponseBodyType,
  Request extends ServerRequest = ServerRequest,
> = (req: Request, res: ServerResponse, next: Next) => ResponseBody | Promise<ResponseBody>

// Serve -----------------------------------------------------------------------

export interface ServeOptions {
  trustProxy?: boolean
  onError?: (err: Error) => void | Promise<void>
}

export function serve(handler: Handler, options: ServeOptions = {}) {
  return async function (req: http.IncomingMessage, res: http.ServerResponse) {
    try {
      const serverRequest = requestFromHTTP(req, options)
      const serverResponse = responseFromHTTP(res)
      await handler(serverRequest, serverResponse, async (_, res) => notFound(res))
    } catch (error) {
      if (options.onError) await options.onError(error)
      else if (!res.writableEnded) sendError(res, error)
    }
  }
}

// Request ---------------------------------------------------------------------

function requestFromHTTP(req: http.IncomingMessage, options: ServeOptions): ServerRequest {
  const originalURL = req.url!

  const serverRequest: ServerRequest = Object.defineProperties<ServerRequest>(req as unknown as ServerRequest, {
    protocol: cachedGetter(req, () => {
      const socketProtocol = Boolean((req.socket as tls.TLSSocket).encrypted) ? 'https' : 'http'
      if (!options.trustProxy) return socketProtocol
      const headerProtocol = getHeader(serverRequest, 'x-forwarded-proto') ?? socketProtocol
      const commaIndex = headerProtocol.indexOf(',')
      return commaIndex === -1 ? headerProtocol.trim() : headerProtocol.substring(0, commaIndex).trim()
    }),

    query: cachedGetter(req, () => {
      return Object.fromEntries(serverRequest.url.searchParams)
    }),

    url: cachedGetter(req, () => {
      return new URL(originalURL, `http://${req.headers.host}`)
    }),
  })

  return serverRequest
}

export function getHeader(req: ServerRequest, header: string): string | undefined {
  const value = req.headers[header]
  return Array.isArray(value) ? value[0] : value
}

export interface RequestBodyOptions {
  limit?: string
  encoding?: string
}

const requestBodyMap = new WeakMap()

export async function buffer(req: ServerRequest, {limit = '1mb', encoding}: RequestBodyOptions = {}) {
  const type = req.headers['content-type'] ?? 'text/plain'
  const length = req.headers['content-length']

  if (encoding === undefined) {
    encoding = contentType.parse(type).parameters.charset
  }

  const existingBody = requestBodyMap.get(req)
  if (existingBody) return existingBody

  try {
    const body = Buffer.from(await getRawBody(req as any, {limit, length, encoding}))
    requestBodyMap.set(req, body)
    return body
  } catch (error) {
    if (error.type === 'entity.too.large') {
      throw createError(413, `Body exceeded ${limit} limit`, error)
    }
    throw createError(400, 'Invalid body', error)
  }
}

export async function text(req: ServerRequest, options: RequestBodyOptions = {}) {
  return await buffer(req, options).then((body) => body.toString())
}

export async function json(req: ServerRequest, options: RequestBodyOptions = {}) {
  return await text(req, options).then((body) => {
    try {
      return JSON.parse(body)
    } catch (error) {
      throw createError(400, 'Invalid JSON', error)
    }
  })
}

// Response --------------------------------------------------------------------

function responseFromHTTP(res: http.ServerResponse): ServerResponse {
  const serverResponse: ServerResponse = Object.defineProperties(res, {})
  return serverResponse
}

export function send(res: ServerResponse, code: number, body: ResponseBodyType = null) {
  res.statusCode = code

  if (body === null || body === undefined) {
    res.end()
    return
  }

  if (body instanceof Stream || isReadableStream(body)) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }
    body.pipe(res)
    return
  }

  if (Buffer.isBuffer(body)) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/octet-stream')
    }
    res.setHeader('Content-Length', body.length)
    res.end(body)
    return
  }

  let stringifiedBody: string

  if (typeof body === 'object' || typeof body === 'number') {
    stringifiedBody = JSON.stringify(body)
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
    }
  } else {
    stringifiedBody = body
  }

  res.setHeader('Content-Length', Buffer.byteLength(stringifiedBody))
  res.end(stringifiedBody)
}

export function sendError(res: ServerResponse, error: HttpError) {
  const statusCode = error.statusCode
  const message = statusCode ? error.message : 'Internal Server Error'
  send(res, statusCode ?? 500, IS_DEV ? error.stack : message)
  console.error(error.stack)
}

export function notFound(res: ServerResponse) {
  send(res, 404, 'Not Found')
}

// Router ----------------------------------------------------------------------

const notFoundMiddleware: Handler = async (_, res) => send(res, 404, 'Not Found')

export function router(...middleware: Handler<ResponseBodyType, ServerRequest<any, any>>[]) {
  return async function (req: ServerRequest, res: ServerResponse) {
    const next = async (req: ServerRequest, res: ServerResponse, idx: number) => {
      const current = middleware[idx] ?? notFoundMiddleware
      await current(req, res, (req, res) => next(req, res, idx + 1))
    }

    await next(req, res, 0)
  }
}

export type RouteHandler<
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
  ResponseBody extends ResponseBodyType = ResponseBodyType,
  Request extends ServerRequest = ServerRequest,
> = Handler<ResponseBody, Request> & {method: Method; route: Route; compilePath: (params?: Request['params']) => string}

// Type signature without a body validator
export function route<
  ResponseBody extends ResponseBodyType,
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
>(
  method: Method,
  path: Route,
  handler: Handler<ResponseBody, ServerRequest<RouteParams<Route>>>,
): RouteHandler<Method, Route, ResponseBody, ServerRequest<RouteParams<Route>>>

// Type signature with a body validator
export function route<
  RequestBody extends object = object,
  ResponseBody extends ResponseBodyType = ResponseBodyType,
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
>(
  method: Method,
  path: Route,
  handler: Handler<ResponseBody, ServerRequest<RouteParams<Route>>>,
  validator: (body: object) => body is RequestBody,
): RouteHandler<Method, Route, ResponseBody, ServerRequest<RouteParams<Route>, RequestBody>>

// Implementation
export function route<
  RequestBody extends object = object,
  ResponseBody extends ResponseBodyType = ResponseBodyType,
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
>(
  method: Method,
  path: Route,
  handler: Handler<ResponseBody, ServerRequest<any>>,
  validator?: (body: object) => body is RequestBody,
): RouteHandler {
  const matchPath = match<RouteParams<Route>>(path)
  const compilePath = compile<any>(path)

  const routeHandler: Handler = async (req, res, next) => {
    if (req.method !== method) return await next(req, res)
    const pathMatch = matchPath(req.url.pathname)
    if (!pathMatch) return await next(req, res)

    req.params = pathMatch.params

    let body: object | undefined = undefined
    if (validator) {
      body = await json(req)
      if (typeof body !== 'object' || body === null || !validator(body)) {
        return sendError(res, createError(422, 'Request body failed validation'))
      }
    }

    const responseBody = await Promise.resolve(handler(Object.assign(req, {body}), res, next))

    if (responseBody === null) {
      send(res, 204, null)
      return
    }

    if (responseBody !== undefined) {
      send(res, res.statusCode ?? 200, responseBody)
    }
  }

  return Object.assign(routeHandler, {method, route: path, compilePath})
}

// Errors ----------------------------------------------------------------------

export interface HttpError extends Error {
  statusCode?: number
  originalError?: Error
}

export function createError(code: number, message: string, original?: Error): HttpError {
  const error: HttpError = new Error(message)
  error.statusCode = code
  error.originalError = original
  return error
}

// Utilities -------------------------------------------------------------------

function isStream(val: unknown): val is Stream {
  return val !== null && typeof val === 'object' && typeof (val as Stream).pipe === 'object'
}

function isReadableStream(val: unknown): val is Readable {
  return (
    isStream(val) &&
    (val as any).readable !== false &&
    typeof (val as Readable)._read === 'function' &&
    typeof (val as any)._readableState === 'object'
  )
}

function cachedGetter<T>(obj: object, getter: () => T) {
  const cache = new WeakMap()
  return {
    get: (): T => {
      if (cache.has(obj)) return cache.get(obj)
      const value = getter()
      cache.set(obj, value)
      return value
    },
    enumerable: true,
  }
}

// TODO: can we support more param types here?
export type RouteParams<T extends string> = T extends `${string}:${infer P}?/${infer Rest}`
  ? {[K in P]?: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}/${infer Rest}`
  ? {[K in P]: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}?`
  ? {[K in P]?: string}
  : T extends `${string}:${infer P}`
  ? {[K in P]: string}
  : {}
