const express = require('express');
const path = require('path');
const { parseToSheets, sendFromSheets, getNewLogs } = require('./senderService');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));

app.post('/api/parse', (req, res) => {
    const { groupUrl, category, count, scrollDelay } = req.body;
    parseToSheets(groupUrl, category, count, scrollDelay); 
    res.json({ status: 'started' });
});

app.post('/api/send', (req, res) => {
    const { message } = req.body;
    sendFromSheets(message); // Запуск в фоне
    res.json({ status: 'started' });
});

// Новый роут для отдачи логов фронтенду
app.get('/api/logs', (req, res) => {
    const logs = getNewLogs();
    res.json({ logs });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(3000, () => console.log('Сервер: http://localhost:3000'));