const fs = require('fs');
if (!fs.existsSync('dist')) fs.mkdirSync('dist');
fs.writeFileSync('dist/index.html', '<!DOCTYPE html><html><head><title>Vite SPA Built</title></head><body><h1>DeployHub Vite App Built</h1></body></html>');
console.log('Build completed successfully!');
