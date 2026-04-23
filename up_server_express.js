const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const path = require('path');
const fs = require('fs').promises;
const fsSync = require('fs');
const { exec } = require('child_process');
const util = require('util');
const execPromise = util.promisify(exec);

// Configuration from environment
const APP_PORT = process.env.APP_PORT || 80;
const APP_IP = process.env.APP_IP || '';

const BASE_DIR = path.resolve(__dirname);
const indexPath = path.join(BASE_DIR, 'www', 'up.html');
const tmpDir = path.join(BASE_DIR, 'tmp');
const videoDir = path.join(BASE_DIR, 'Video');

// Files tracking object
const Files = {};

// Detailed logger utility
const logger = {
    info: (message, data = {}) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [INFO] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
    },
    error: (message, error = {}) => {
        const timestamp = new Date().toISOString();
        console.error(`[${timestamp}] [ERROR] ${message}`, error.stack || error);
    },
    warn: (message, data = {}) => {
        const timestamp = new Date().toISOString();
        console.warn(`[${timestamp}] [WARN] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
    },
    debug: (message, data = {}) => {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [DEBUG] ${message}`, Object.keys(data).length ? JSON.stringify(data) : '');
    }
};

// Initialize Express app
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

// Ensure directories exist
async function ensureDirectories() {
    try {
        await fs.mkdir(tmpDir, { recursive: true });
        logger.info('Temporary directory ensured', { path: tmpDir });
        await fs.mkdir(videoDir, { recursive: true });
        logger.info('Video directory ensured', { path: videoDir });
    } catch (error) {
        logger.error('Failed to create directories', error);
        throw error;
    }
}

// Serve static HTML file
app.get('/', async (req, res) => {
    try {
        logger.info('Serving index.html', { path: indexPath });
        const data = await fs.readFile(indexPath);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(data);
    } catch (error) {
        logger.error('Error loading index.html', error);
        res.writeHead(500);
        res.end('Error loading index.html');
    }
});

// Socket.IO connection handler
io.on('connection', (socket) => {
    logger.info('New client connected', { socketId: socket.id });

    // Handle Start event
    socket.on('Start', async (data) => {
        try {
            logger.info('Upload started', { socketId: socket.id, fileName: data.Name, fileSize: data.Size });
            
            const Name = data.Name;
            Files[Name] = {
                FileSize: data.Size,
                Data: "",
                Downloaded: 0
            };

            let Place = 0;
            
            try {
                const filePath = path.join(tmpDir, Name);
                const stat = await fs.stat(filePath);
                if (stat.isFile()) {
                    Files[Name].Downloaded = stat.size;
                    Place = stat.size / 524288;
                    logger.info('Resuming existing file', { fileName: Name, size: stat.size });
                }
            } catch (err) {
                logger.debug('New file upload', { fileName: Name });
            }

            const filePath = path.join(tmpDir, Name);
            const fd = await fs.open(filePath, 'a', 0o755);
            Files[Name].Handler = fd;
            
            socket.emit('MoreData', { Place: Place, Percent: 0 });
            logger.info('File opened for writing', { fileName: Name, fd: fd.fd });
            
        } catch (error) {
            logger.error('Error in Start handler', error);
            socket.emit('Error', { message: 'Failed to start upload', error: error.message });
        }
    });

    // Handle Upload event
    socket.on('Upload', async (data) => {
        try {
            const Name = data.Name;
            
            if (!Files[Name]) {
                logger.warn('Upload received for unknown file', { fileName: Name });
                return;
            }

            Files[Name].Downloaded += data.Data.length;
            Files[Name].Data += data.Data;

            logger.debug('Upload chunk received', { 
                fileName: Name, 
                downloaded: Files[Name].Downloaded, 
                total: Files[Name].FileSize,
                bufferLength: Files[Name].Data.length 
            });

            // Check if file is fully uploaded
            if (Files[Name].Downloaded === Files[Name].FileSize) {
                logger.info('File upload complete', { fileName: Name, totalSize: Files[Name].FileSize });
                
                const filePath = path.join(tmpDir, Name);
                const writePath = path.join(videoDir, Name);
                
                await fs.writeFile(filePath, Files[Name].Data, 'binary');
                logger.info('File written to tmp', { fileName: Name });

                // Move file to Video directory
                await fs.copyFile(filePath, writePath);
                logger.info('File copied to Video directory', { fileName: Name });

                // Generate thumbnail for MP4 files
                let base64str;
                if (Name.endsWith('.mp4')) {
                    try {
                        const thumbPath = path.join(videoDir, `${Name}.jpg`);
                        await execPromise(`ffmpeg -i "${writePath}" -ss 00:01 -r 1 -an -vframes 1 -f mjpeg "${thumbPath}"`);
                        logger.info('Thumbnail generated', { fileName: Name, thumbPath });
                        
                        const thumbData = await fs.readFile(thumbPath);
                        base64str = thumbData.toString('base64');
                    } catch (ffmpegError) {
                        logger.error('FFmpeg error', ffmpegError);
                        base64str = '';
                    }
                } else {
                    logger.info('Non-MP4 file, using default image', { fileName: Name });
                    try {
                        const defaultImgPath = path.join(BASE_DIR, 'file.png');
                        const imgData = await fs.readFile(defaultImgPath);
                        base64str = imgData.toString('base64');
                    } catch (err) {
                        base64str = '';
                    }
                }

                // Clean up temp file
                try {
                    await fs.unlink(filePath);
                    logger.info('Temp file deleted', { fileName: Name });
                } catch (unlinkErr) {
                    logger.warn('Failed to delete temp file', { fileName: Name, error: unlinkErr.message });
                }

                // Close file handler
                if (Files[Name].Handler) {
                    await Files[Name].Handler.close();
                }

                socket.emit('Done', { Image: base64str });
                logger.info('Upload completed and emitted to client', { fileName: Name });
                
                // Clean up Files entry
                delete Files[Name];

            } else if (Files[Name].Data.length > 10485760) {
                // Buffer reached 10MB, write to disk
                logger.debug('Buffer full, writing to disk', { fileName: Name, bufferSize: Files[Name].Data.length });
                
                const filePath = path.join(tmpDir, Name);
                await fs.appendFile(filePath, Files[Name].Data, 'binary');
                Files[Name].Data = "";
                
                const Place = Files[Name].Downloaded / 524288;
                const Percent = (Files[Name].Downloaded / Files[Name].FileSize) * 100;
                
                socket.emit('MoreData', { Place: Place, Percent: Percent });
            } else {
                // Continue uploading
                const Place = Files[Name].Downloaded / 524288;
                const Percent = (Files[Name].Downloaded / Files[Name].FileSize) * 100;
                
                socket.emit('MoreData', { Place: Place, Percent: Percent });
            }
            
        } catch (error) {
            logger.error('Error in Upload handler', error);
            socket.emit('Error', { message: 'Upload failed', error: error.message });
        }
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        logger.info('Client disconnected', { socketId: socket.id });
        
        // Clean up any open file handlers
        for (const fileName in Files) {
            if (Files[fileName].Handler) {
                Files[fileName].Handler.close().catch(err => {
                    logger.error('Error closing file handler on disconnect', err);
                });
            }
        }
    });

    // Handle errors
    socket.on('error', (error) => {
        logger.error('Socket error', error);
    });
});

// Global error handler for uncaught exceptions
process.on('uncaughtException', (error) => {
    logger.error('Uncaught Exception', error);
});

// Global error handler for unhandled promise rejections
process.on('unhandledRejection', (reason, promise) => {
    logger.error('Unhandled Rejection at', { promise: promise.toString(), reason });
});

// Start server
async function startServer() {
    try {
        await ensureDirectories();
        
        server.listen(APP_PORT, APP_IP, () => {
            logger.info('Server started successfully', { 
                port: APP_PORT, 
                ip: APP_IP || 'all interfaces',
                url: `http://${APP_IP || 'localhost'}:${APP_PORT}/`
            });
        });
        
    } catch (error) {
        logger.error('Failed to start server', error);
        process.exit(1);
    }
}

startServer();
