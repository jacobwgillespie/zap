# ⚡ zap [![npm](https://badgen.net/npm/v/zap)](https://www.npmjs.com/package/zap) [![CI](https://github.com/jacobwgillespie/zap/actions/workflows/ci.yml/badge.svg)](https://github.com/jacobwgillespie/zap/actions/workflows/ci.yml)

Zap is a lightweight HTTP server framework for Node.

- [Installation](#installation)
- [Usage](#usage)
- [API](#api)
- [Recipes](#recipes)
- [Credits](#credits)
- [License](#license)

## Installation

Install with your favorite package manager:

```shell
$ pnpm add zap
$ yarn add zap
$ npm install zap
```

## Usage

```typescript
import {route, router, serve} from 'zap'

const app = router(
  route('GET', '/', () => 'Hello World'),

  route('GET', '/hello/:name', (req) => `Hello ${req.params.name}`),
)

const server = http.createServer(serve(app))
server.listen(3000)
```

## API

### `serve(handler, options)`

Constructs a new `http.RequestListener` out of a `Handler`.

### `router(...routes)`

Constructs a new `Handler` out of a list of `RouteHandlers`.

### `route(method, path, handler)`

Constructs a `RouteHandler` that matches a given method (`GET`, `POST`, etc) and path.

### Body parsers

- `buffer(req, options)` - read the request body as a `Buffer`
- `text(req, options)` - read the request body as a string
- `json(req, options)` - read the request body as parsed JSON

### Request helpers

- `getHeader(req, header)` - returns the requested header if it was provided
- `fromRequest(fn)` - wraps a function in the form `(req: ServerRequest, ...rest) => any` to return an equivalent function that caches its results for the provided request

### Response helpers

- Ordinarily you would return a `ResponseBodyType` from a `Handler` function
- `send(res, statusCode, body)` - a response with a given status code
- `notFound()` - a 404 response
- `redirect(location, statusCode)` - a redirect to another location (default status code 303)
- `httpError(code, message, metadata)` - an error response with a given code, message, and optional metadata

## Recipes

### Validating body schema

You can use a function that throws an `httpError` to provide type-safe body payload parsing:

```typescript
async function parseBody(req: ServerRequest) {
  const body = await json(req)
  if (!validate(body)) throw httpError(400, 'invalid body')
  return body
}

route('POST', '/example', (req) => {
  const body = await parseBody(req)
  // body is now typed according to your parseBody return type
})
```

### Error handling

The `serve()` function options accept an `errorHandler` that will replace `zap`'s built-in error handler. This allows you to report errors to services like Sentry, format the response sent to the user, etc.

```typescript
serve(handler, {
  errorHandler: (_, res, error) => {
    send(res, 500, {message: 'Internal server error', details: formatError(error)})
  },
})
```

## Credits

Special thanks to [@nornagon](https://github.com/nornagon) for the `zap` package name. For versions of this module published before `v1.0.0`, see [nornagon/node-zap](https://github.com/nornagon/node-zap).

## License

MIT License, see `LICENSE`.
