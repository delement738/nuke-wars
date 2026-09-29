// SERVER — entry point. `npm run server` runs this.
//
// PORT is set by the host in production (Railway, Session 8); locally it
// defaults to 8787, which is what the client's `.env.development` points at.

import { startServer } from './server';

const port = Number(process.env.PORT ?? 8787);

startServer(port, { log: (line) => console.log(line) }).then((server) => {
  console.log(`Nuke Wars server listening on port ${server.port}`);
});
