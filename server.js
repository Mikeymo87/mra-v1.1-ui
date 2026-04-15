const express = require('express');
const path = require('path');
const app = express();

app.use(express.static(path.join(__dirname, 'public')));

const PORT = 3002;
app.listen(PORT, () => {
  console.log(`\n✅ BH Market Research Agent running at http://localhost:${PORT}\n`);
});
