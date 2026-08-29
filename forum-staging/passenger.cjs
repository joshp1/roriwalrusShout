'use strict';

import('./main.js')
  .then(({ startServer }) => startServer())
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });