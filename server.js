const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const { exec } = require('child_process');
const util = require('util');
const winston = require('winston');

// Настройка логгера
const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    winston.format.errors({ stack: true }),
    winston.format.splat(),
    winston.format.json()
  ),
  defaultMeta: { service: 'upload-server' },
  transports: [
    new winston.transports.File({ filename: 'error.log', level: 'error' }),
    new winston.transports.File({ filename: 'combined.log' }),
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.colorize(),
        winston.format.simple()
      )
    })
  ]
});

// Промисификация exec
const execPromise = util.promisify(exec);

// Переменные окружения
const APP_PORT = process.env.APP_PORT || 80;
const APP_IP = process.env.APP_IP || '';

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const Files = {};

// Middleware для логирования запросов
app.use((req, res, next) => {
  logger.info(`${req.method} ${req.url} from ${req.ip}`);
  const start = Date.now();
  res.on('finish', () => {
    logger.info(`${req.method} ${req.url} completed with status ${res.statusCode} in ${Date.now() - start}ms`);
  });
  next();
});

// Статический файл для главной страницы
app.get('/', async (req, res) => {
  try {
    const indexPath = path.join(__dirname, 'www', 'up.html');
    const data = await fs.readFile(indexPath);
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(data);
  } catch (err) {
    logger.error('Error loading index.html:', err);
    res.writeHead(500);
    res.end('Error loading index.html');
  }
});

// Обработка ошибок в Express
app.use((err, req, res, next) => {
  logger.error('Express error handler:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

/**
 * Вспомогательные функции
 */
String.prototype.file_type = function() {
  return this.split('.').pop();
};

async function base64_encode(file) {
  try {
    const bitmap = await fs.readFile(file);
    return bitmap.toString('base64');
  } catch (err) {
    logger.error(`Error encoding file ${file}:`, err);
    throw err;
  }
}

/**
 * Socket.IO соединение
 */
io.on('connection', (socket) => {
  logger.info(`Client connected: ${socket.id}`);

  socket.on('Start', async (data) => {
    try {
      const Name = data['Name'];
      logger.info(`Upload started for file: ${Name}, size: ${data['Size']}`);

      Files[Name] = {
        FileSize: data['Size'],
        Data: '',
        Downloaded: 0
      };

      let Place = 0;
      try {
        const tmpPath = path.join('tmp', Name);
        const stat = await fs.stat(tmpPath);
        if (stat.isFile()) {
          Files[Name]['Downloaded'] = stat.size;
          Place = stat.size / 524288;
          logger.info(`Resuming upload for ${Name}, already downloaded: ${stat.size}`);
        }
      } catch (err) {
        logger.info(`New file upload: ${Name}`);
      }

      const tmpPath = path.join('tmp', Name);
      const fd = await fs.open(tmpPath, 'a', 0o755);
      Files[Name]['Handler'] = fd;
      socket.emit('MoreData', { 'Place': Place, 'Percent': 0 });
    } catch (err) {
      logger.error('Error in Start event:', err);
      socket.emit('error', { message: 'Failed to start upload' });
    }
  });

  socket.on('Upload', async (data) => {
    try {
      const Name = data['Name'];
      Files[Name]['Downloaded'] += data['Data'].length;
      Files[Name]['Data'] += data['Data'];

      if (Files[Name]['Downloaded'] === Files[Name]['FileSize']) {
        logger.info(`File fully uploaded: ${Name}`);
        
        const tmpPath = path.join('tmp', Name);
        const videoPath = path.join('Video', Name);
        
        await fs.writeFile(tmpPath, Files[Name]['Data'], 'binary');
        
        // Создаем директорию Video если не существует
        await fs.mkdir('Video', { recursive: true });
        
        const inp = fs.createReadStream(tmpPath);
        const out = fs.createWriteStream(videoPath);
        
        await new Promise((resolve, reject) => {
          inp.pipe(out);
          inp.on('end', resolve);
          inp.on('error', reject);
        });
        
        logger.info(`File moved to Video/${Name}`);
        
        // Удаляем временный файл
        try {
          await fs.unlink(tmpPath);
          logger.info(`Deleted temporary file: ${tmpPath}`);
        } catch (unlinkErr) {
          logger.warn(`Could not delete temp file ${tmpPath}:`, unlinkErr);
        }

        // Генерация превью для MP4
        if (Name.file_type() === 'mp4') {
          try {
            const jpgPath = path.join('Video', `${Name}.jpg`);
            await execPromise(`ffmpeg -i "${videoPath}" -ss 00:01 -r 1 -an -vframes 1 -f mjpeg "${jpgPath}"`);
            logger.info(`Generated thumbnail: ${jpgPath}`);
            
            const base64str = await base64_encode(jpgPath);
            socket.emit('Done', { 'Image': base64str });
          } catch (ffmpegErr) {
            logger.error('FFmpeg error:', ffmpegErr);
            const base64str = await base64_encode(path.join(__dirname, 'file.png'));
            socket.emit('Done', { 'Image': base64str });
          }
        } else {
          try {
            const base64str = await base64_encode(path.join(__dirname, 'file.png'));
            socket.emit('Done', { 'Image': base64str });
          } catch (imgErr) {
            logger.error('Error reading default image:', imgErr);
            socket.emit('Done', { 'Image': '' });
          }
        }

        // Закрываем файловый дескриптор
        if (Files[Name]['Handler']) {
          await Files[Name]['Handler'].close();
        }
        
        delete Files[Name];
      } else if (Files[Name]['Data'].length > 10485760) {
        // Буфер достиг 10MB
        const tmpPath = path.join('tmp', Name);
        await fs.appendFile(tmpPath, Files[Name]['Data'], 'binary');
        Files[Name]['Data'] = '';
        
        const Place = Files[Name]['Downloaded'] / 524288;
        const Percent = (Files[Name]['Downloaded'] / Files[Name]['FileSize']) * 100;
        socket.emit('MoreData', { 'Place': Place, 'Percent': Percent });
      } else {
        const Place = Files[Name]['Downloaded'] / 524288;
        const Percent = (Files[Name]['Downloaded'] / Files[Name]['FileSize']) * 100;
        socket.emit('MoreData', { 'Place': Place, 'Percent': Percent });
      }
    } catch (err) {
      logger.error('Error in Upload event:', err);
      socket.emit('error', { message: 'Upload failed' });
    }
  });

  socket.on('disconnect', () => {
    logger.info(`Client disconnected: ${socket.id}`);
  });

  socket.on('error', (err) => {
    logger.error(`Socket error for ${socket.id}:`, err);
  });
});

// Глобальная обработка необработанных исключений
process.on('uncaughtException', (err) => {
  logger.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

// Запуск сервера
server.listen(APP_PORT, APP_IP, () => {
  logger.info(`Server running at http://${APP_IP}:${APP_PORT}/`);
}).on('error', (err) => {
  logger.error('Server failed to start:', err);
  process.exit(1);
});

module.exports = { app, server, io };
