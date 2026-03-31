const fs = require('fs');
const https = require('https');
const path = require('path');

const html = fs.readFileSync('bili.html', 'utf8');
const urls = [];
const regex = /https:\\u002F\\u002Fi0\.hdslb\.com\\u002Fbfs\\u002Fnew_dyn\\u002F[a-zA-Z0-9]+\.jpg/g;
let match;
while ((match = regex.exec(html)) !== null) {
    const url = match[0].replace(/\\u002F/g, '/');
    if (!urls.includes(url)) {
        urls.push(url);
    }
}

console.log(`Found ${urls.length} image URLs.`);

if (!fs.existsSync('imgs')) {
    fs.mkdirSync('imgs');
}

urls.forEach((url, i) => {
    const filePath = path.join(__dirname, 'imgs', `${i}.jpg`);
    https.get(url, (res) => {
        const file = fs.createWriteStream(filePath);
        res.pipe(file);
        file.on('finish', () => {
            file.close();
            console.log(`Downloaded ${i}.jpg`);
        });
    });
});
