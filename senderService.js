const puppeteer = require('puppeteer');
const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const path = require('path');
require('dotenv').config();

const creds = require('./google-keys.json');

// Очередь для хранения логов перед отправкой на фронт
let logQueue = [];
const log = (msg) => {
    console.log(msg);
    logQueue.push(msg);
};

// Функция для получения новых логов (очищает очередь после вызова)
function getNewLogs() {
    const logs = [...logQueue];
    logQueue = [];
    return logs;
}

const auth = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});

const doc = new GoogleSpreadsheet(String(process.env.Table_ID), auth);
const HEADERS = ['ФИО', 'ссылка', 'источник(группа)', 'тематика', 'было ли оправлено сообщение'];

async function getOrCreateSheet(title) {
    await doc.loadInfo();
    const safeTitle = title.replace(/[^\w\sа-яА-Я]/gi, '').substring(0, 30) || 'Результаты';
    let sheet = doc.sheetsByTitle[safeTitle];
    if (!sheet) {
        log(`Создаю лист: ${safeTitle}`);
        sheet = await doc.addSheet({ title: safeTitle, headerValues: HEADERS });
    }
    return sheet;
}

async function initBrowser() {
    const userDataDir = path.resolve(__dirname, 'session_data');
    const browser = await puppeteer.launch({ 
        headless: false,
        userDataDir: userDataDir, 
        args: ['--no-sandbox', '--disable-notifications', '--window-size=1280,800'] 
    });

    const page = await browser.newPage();
    await page.setDefaultNavigationTimeout(60000);
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    
    return { browser, page };
}

async function checkAuth(page) {
    log('Проверка авторизации...');
    await page.goto('https://vk.com/feed', { waitUntil: 'domcontentloaded' });
    const isLoggedIn = await page.evaluate(() => !!document.querySelector('.vkitLeftMenuItem__icon--Bk4Ld, #top_profile_link, .TopNavBtn__profileImg'));

    if (!isLoggedIn) {
        log('НУЖЕН ВХОД! Войдите в открывшемся окне браузера...');
        await page.waitForSelector('.vkitLeftMenuItem__icon--Bk4Ld, #top_profile_link', { timeout: 0 });
        log('Вход выполнен!');
    } else {
        log('Сессия активна.');
    }
}

async function parseToSheets(groupUrl, category, count = 50, scrollDelay = 2000) {
    const { browser, page } = await initBrowser();
    try {
        await checkAuth(page);
        log(`Переход в группу: ${groupUrl}`);
        await page.setViewport({ width: 1280, height: 1000 });
        await page.goto(groupUrl, { waitUntil: 'domcontentloaded' });

        log('Ищу кнопку подписчиков...');

        // 1. Более надежный поиск кнопки через текст
        await page.waitForFunction(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            return elements.some(el => el.innerText && el.innerText.trim() === 'Подписчики');
        }, { timeout: 10000 });

        const clickSuccess = await page.evaluate(() => {
            const elements = Array.from(document.querySelectorAll('*'));
            const target = elements.find(el => el.innerText && el.innerText.trim() === 'Подписчики');
            if (target) {
                // Кликаем в родителя, который является кнопкой
                const parent = target.closest('[role="button"]') || target.parentElement;
                parent.click();
                return true;
            }
            return false;
        });

        if (!clickSuccess) throw new Error('Не удалось кликнуть по кнопке подписчиков');
        
        log('Клик выполнен. Жду модальное окно...');

        // 2. Ждем именно появления элементов пользователей
        const cellSelector = '[data-testid^="grid-item"]';
        await page.waitForSelector(cellSelector, { timeout: 15000 });
        log('Список участников открыт. Начинаю скроллинг...');

        let currentCount = 0;
        let attempts = 0;
        let lastCount = 0;

        // 3. Агрессивный скролл
        while (currentCount < count && attempts < 50) {
            // Фокусируемся на теле модалки и жмем PageDown
            await page.keyboard.press('PageDown');
            
            // Дополнительно: скроллим контейнер JS-ом
            await page.evaluate((sel) => {
                const container = document.querySelector('.vkuiCustomScrollView__host');
                if (container) {
                    container.scrollTop += 1000;
                }
            });

            await new Promise(r => setTimeout(r, scrollDelay));

            currentCount = await page.evaluate((sCell) => {
                return document.querySelectorAll(sCell).length;
            }, cellSelector);

            log(`Загружено: ${currentCount} из ${count}.`);

            // Если количество не растет 5 раз подряд — считаем, что конец списка
            if (currentCount === lastCount) {
                attempts++;
            } else {
                attempts = 0;
                lastCount = currentCount;
            }
            
            if (currentCount >= count) break;
        }

        log('Парсинг данных...');
        const users = await page.evaluate((group, cat, targetCount, sCell) => {
            const items = Array.from(document.querySelectorAll(sCell));
            return items.slice(0, targetCount).map(item => {
                const linkEl = item.querySelector('a[href*="/"]');
                const nameEl = item.querySelector('.vkitTextClamp__root--ewZ0L') || linkEl;я
                return {
                    'ФИО': nameEl ? nameEl.innerText.trim() : 'Не указано',
                    'ссылка': linkEl ? linkEl.href : '',
                    'источник(группа)': group,
                    'тематика': cat,
                    'было ли оправлено сообщение': 'Нет'
                };
            }).filter(u => u.ссылка);
        }, groupUrl, category, count, cellSelector);

        const sheet = await getOrCreateSheet(groupUrl.split('/').pop());
        await sheet.addRows(users);
        log(`Успешно! Добавлено ${users.length} пользователей.`);

    } catch (err) {
        log(`Критическая ошибка: ${err.message}`);
    } finally {
        await browser.close();
    }
}

async function sendFromSheets(messageText) {
    const { browser, page } = await initBrowser();
    try {
        await checkAuth(page);
        await doc.loadInfo();

        for (const sheet of doc.sheetsByIndex) {
            log(`Обработка листа: ${sheet.title}`);
            const rows = await sheet.getRows();

            for (const row of rows) {
                if (row.get('было ли оправлено сообщение') === 'Нет') {
                    const profileUrl = row.get('ссылка');
                    const name = row.get('ФИО');
                    
                    try {
                        log(`Отправка сообщения: ${name}`);
                        await page.goto(profileUrl, { waitUntil: 'domcontentloaded' });

                        const btnSelector = 'a[href^="/write"], .profile_btn_msg, .FlatButton--primary'; 
                        await page.waitForSelector(btnSelector, { timeout: 5000 });
                        await page.click(btnSelector);

                        const inputSelector = 'div[role="textbox"], #mail_view_msg_body'; 
                        await page.waitForSelector(inputSelector, { visible: true, timeout: 5000 });

                        await page.type(inputSelector, messageText, { delay: 40 });
                        await page.keyboard.press('Enter');

                        row.set('было ли оправлено сообщение', 'Да');
                        await row.save();
                        log(`Сообщение для ${name} отправлено успешно.`);
                        
                        // Задержка между сообщениями
                        await new Promise(r => setTimeout(r, Math.random() * 10000 + 20000));
                    } catch (err) {
                        log(`Пропуск: ${name} (Личные сообщения закрыты или ошибка)`);
                        row.set('было ли оправлено сообщение', 'Закрыто');
                        await row.save();
                    }
                }
            }
        }
    } catch (err) {
        log(`Ошибка рассылки: ${err.message}`);
    } finally {
        log('Работа окончена.');
        await browser.close();
    }
}

module.exports = { parseToSheets, sendFromSheets, getNewLogs }; 