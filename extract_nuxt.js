const fs = require('fs');

const html = fs.readFileSync('mcd_dump.html', 'utf8');
const match = html.match(/<script type="application\/json" data-nuxt-data="nuxt-app" data-ssr="true" id="__NUXT_DATA__">([\s\S]*?)<\/script>/);

if (match) {
    const data = match[1];
    fs.writeFileSync('nuxt_data.json', data);
    console.log("Extracted to nuxt_data.json");
} else {
    console.log("No match found");
}
