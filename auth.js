const fs = require('fs').promises;

async function saveCookies(page, path) {
    const cookies = await page.cookies();
    await fs.writeFile(path, JSON.stringify(cookies, null, 2));
}

async function loadCookies(page, path) {
    try {
        const cookiesString = await fs.readFile(path);
        const cookies = JSON.parse(cookiesString);
        await page.setCookie(...cookies);
        return true;
    } catch (e) {
        return false;
    }
}

module.exports = { saveCookies, loadCookies };