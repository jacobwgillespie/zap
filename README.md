# ⚡ zap [![npm](https://badgen.net/npm/v/zap)](https://www.npmjs.com/package/zap) [![CI](https://github.com/jacobwgillespie/zap/actions/workflows/ci.yml/badge.svg)](https://github.com/jacobwgillespie/zap/actions/workflows/ci.yml)

Zap is a lightweight HTTP server framework for Node.

## Installation

Install with your favorite package manager:

```shell
$ yarn add zap
$ pnpm add zap
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

## Credits

Special thanks to [@nornagon](https://github.com/nornagon) for the `zap` package name. For versions of this module published before `v1.0.0`, see [nornagon/node-zap](https://github.com/nornagon/node-zap).

## License

MIT License, see `LICENSE`.
