const express = require('express');
const open = require('open');

module.exports = server = port => {
  const app = express();
  app.use(express.static(`${__dirname}/../static`));

  app.listen(port, () => {
    console.log(`Example app listening at http://localhost:${port}`);
    (async () => {
      await open(`http://localhost:${port}`);
    })();
  });
};