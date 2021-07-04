# ⚡ zap

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

## License

MIT License, see `LICENSE`.
