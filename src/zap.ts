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

export interface ServerRequest<Params = unknown> extends http.IncomingMessage {
  params: Params
  protocol: 'http' | 'https'
  parsedURL: URL
}

export interface ServerResponse extends http.ServerResponse {}

export type ResponseBodyType = string | object | number | Buffer | Stream | Error | null
export type Handler<
  ResponseBody extends ResponseBodyType = ResponseBodyType,
  Request extends ServerRequest = ServerRequest,
> = (req: Request, res: ServerResponse) => void | ResponseBody | Promise<ResponseBody>
export type ErrorHandler = (
  req: ServerRequest,
  res: ServerResponse,
  err: unknown,
) => void | ResponseBodyType | Promise<ResponseBodyType>

// Serve -----------------------------------------------------------------------

export interface ServeOptions {
  trustProxy?: boolean
  errorHandler?: ErrorHandler
}

export function serve(handler: Handler, options: ServeOptions = {}) {
  return async function (req: http.IncomingMessage, res: http.ServerResponse) {
    const serverRequest = requestFromHTTP(req, options)
    const serverResponse = responseFromHTTP(res)

    try {
      await handler(serverRequest, serverResponse)
    } catch (error) {
      if (res.writableEnded) throw error

      if (error instanceof RedirectError) {
        res.statusCode = error.statusCode
        res.setHeader('Location', error.location)
        res.end()
        return
      }

      const errorHandler = options.errorHandler ?? ((_, res, error) => sendError(res, error))
      errorHandler(serverRequest, serverResponse, error)
    }
  }
}

// Request ---------------------------------------------------------------------

const protocolFromRequest = fromRequest((req, options: ServeOptions) => {
  const socketProtocol = Boolean((req.socket as tls.TLSSocket).encrypted) ? 'https' : 'http'
  if (!options.trustProxy) return socketProtocol
  const headerProtocol = getHeader(req, 'x-forwarded-proto') ?? socketProtocol
  const commaIndex = headerProtocol.indexOf(',')
  return commaIndex === -1 ? headerProtocol.trim() : headerProtocol.substring(0, commaIndex).trim()
})

const queryFromRequest = fromRequest((req) => {
  return Object.fromEntries(req.parsedURL.searchParams)
})

const urlFromRequest = fromRequest((req) => {
  return new URL(req.url!, `${req.protocol}://${req.headers.host}`)
})

function requestFromHTTP(req: http.IncomingMessage, options: ServeOptions): ServerRequest {
  const serverRequest: ServerRequest = Object.defineProperties<ServerRequest>(req as unknown as ServerRequest, {
    protocol: {get: () => protocolFromRequest(serverRequest, options), enumerable: true},
    query: {get: () => queryFromRequest(serverRequest), enumerable: true},
    parsedURL: {get: () => urlFromRequest(serverRequest), enumerable: true},
  })
  return serverRequest
}

export function getHeader(req: http.IncomingMessage, header: string): string | undefined {
  const value = req.headers[header]
  return Array.isArray(value) ? value[0] : value
}

export interface RequestBodyOptions {
  limit?: string
  encoding?: string
}

const requestBodyMap = new WeakMap<http.IncomingMessage, Buffer>()

export async function buffer(req: http.IncomingMessage, {limit = '1mb', encoding}: RequestBodyOptions = {}) {
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
  } catch (error: any) {
    if (error.type === 'entity.too.large') {
      throw httpError(413, `Body exceeded ${limit} limit`, error)
    }
    throw httpError(400, 'Invalid body', error)
  }
}

export async function text(req: http.IncomingMessage, options: RequestBodyOptions = {}) {
  return await buffer(req, options).then((body) => body.toString())
}

export async function json(req: http.IncomingMessage, options: RequestBodyOptions = {}) {
  return await text(req, options).then((body) => {
    try {
      return JSON.parse(body)
    } catch (error: any) {
      throw httpError(400, 'Invalid JSON', error)
    }
  })
}

// Response --------------------------------------------------------------------

function responseFromHTTP(res: http.ServerResponse): ServerResponse {
  const serverResponse: ServerResponse = Object.defineProperties(res, {})
  return serverResponse
}

export function send(res: http.ServerResponse, code: number, body: ResponseBodyType = null) {
  res.statusCode = code

  if (body === null || body === undefined) {
    res.end()
    return
  }

  // Throw errors so they can be handled by the error handler
  if (body instanceof Error) {
    throw body
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

function sendError(res: http.ServerResponse, error: unknown) {
  if (error instanceof HttpError) {
    send(res, error.statusCode, error.message)
  } else if (error instanceof Error) {
    send(res, 500, IS_DEV ? error.stack : error.message)
  } else {
    send(res, 500, `${error}`)
  }
}

export function notFound() {
  return httpError(404, 'Not Found')
}

// Router ----------------------------------------------------------------------

export function router(...handlers: RouteHandler<HttpMethod, any, ResponseBodyType>[]): Handler {
  return async function (req, res) {
    for (const current of handlers) {
      if (req.method !== current.method) continue
      const match = current.matchPath(req.parsedURL.pathname)
      if (!match) continue
      req.params = match.params
      return await current(req as ServerRequest<any>, res)
    }
    return send(res, 404, 'Not Found')
  }
}

export interface RouteHandler<
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
  ResponseBody extends ResponseBodyType = ResponseBodyType,
> extends Handler<ResponseBody, ServerRequest<RouteParams<Route>>> {
  method: Method
  route: Route
  compilePath: (params?: RouteParams<Route>) => string
  matchPath: (path: string) => false | {params: RouteParams<Route>; path: string; index: number}
}

// Type signature
export function route<
  ResponseBody extends ResponseBodyType,
  Method extends HttpMethod = HttpMethod,
  Route extends string = string,
>(
  method: Method,
  path: Route,
  handler: Handler<ResponseBody, ServerRequest<RouteParams<Route>>>,
): RouteHandler<Method, Route, ResponseBody>

// Implementation
export function route(
  method: HttpMethod,
  path: string,
  handler: Handler<ResponseBodyType, ServerRequest<any>>,
): RouteHandler {
  const routeHandler: Handler = async (req, res) => {
    const responseBody = await Promise.resolve(handler(req, res))
    if (responseBody === null) return send(res, 204, null)
    if (responseBody === undefined) return
    send(res, res.statusCode ?? 200, responseBody)
  }
  return Object.assign(routeHandler, {method, route: path, compilePath: compile<any>(path), matchPath: match(path)})
}

// Errors ----------------------------------------------------------------------

export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public metadata: unknown) {
    super(message)
    if (Error.captureStackTrace) Error.captureStackTrace(this, RedirectError)
  }
}

export function httpError(code: number, message: string, metadata?: unknown): HttpError {
  return new HttpError(code, message, metadata)
}

// Redirects -------------------------------------------------------------------

export class RedirectError extends Error {
  constructor(public statusCode: number, public location: string) {
    super(`Redirect to ${location}, status code ${statusCode}`)
    if (Error.captureStackTrace) Error.captureStackTrace(this, RedirectError)
  }
}

export function redirect(location: string, statusCode = 303) {
  return new RedirectError(statusCode, location)
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

/**
 * Creates a function that caches its results for a given request. Both successful responses
 * and errors are cached.
 *
 * @param fn The function that should be cached.
 * @returns The results of calling the function
 */
export function fromRequest<Fn extends (req: ServerRequest, ...rest: any[]) => any>(fn: Fn): Fn {
  const cache = new WeakMap<ServerRequest, any>()
  const errorCache = new WeakMap<ServerRequest, any>()
  const cachedFn = (req: ServerRequest, ...rest: any[]) => {
    if (errorCache.has(req)) throw errorCache.get(req)
    if (cache.has(req)) return cache.get(req)
    try {
      const value = fn(req, ...rest)
      cache.set(req, value)
      return value
    } catch (error) {
      errorCache.set(req, error)
      throw error
    }
  }
  return cachedFn as Fn
}

// TODO: can we support more param types here?
export type RouteParams<T extends string> = T extends `${string}:${infer P}?/${infer Rest}`
  ? {[K in P]?: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}*/${infer Rest}`
  ? {[K in P]?: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}+/${infer Rest}`
  ? {[K in P]: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}/${infer Rest}`
  ? {[K in P]: string} & RouteParams<Rest>
  : T extends `${string}:${infer P}?`
  ? {[K in P]?: string}
  : T extends `${string}:${infer P}*`
  ? {[K in P]?: string}
  : T extends `${string}:${infer P}+`
  ? {[K in P]: string}
  : T extends `${string}:${infer P}`
  ? {[K in P]: string}
  : {}
