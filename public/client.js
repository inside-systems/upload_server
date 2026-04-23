"use strict";

// Socket.IO connection
const socket = io();

const body = document.querySelector('body');
const upload = document.querySelector('.upload');
const uploadButtonText = document.querySelector('.upload-button-text');
const uploadFilename = document.querySelector('.upload-filename');
const fileInput = document.getElementById('file');

let currentFile = null;

fileInput.onchange = () => {
    if (fileInput.files.length > 0) {
        uploadFile(fileInput.files[0]);
    }
};

function uploadFile(file) {
    if (file) {
        currentFile = file;
        // Add the file name to the input and change the button to an upload button
        uploadFilename.classList.remove('inactive');
        uploadFilename.innerText = file.name;
        uploadButtonText.innerText = 'Upload';
        fileInput.remove();
        
        uploadButtonText.addEventListener("click", async () => {
            try {
                logger.info('Starting file upload', { fileName: file.name, fileSize: file.size });
                
                upload.classList.add("uploading");
                
                // Initialize upload via socket
                socket.emit('Start', { Name: file.name, Size: file.size });
                
                let place = 0;
                let uploadedSize = 0;
                const chunkSize = 524288; // 512KB chunks
                
                // Handle MoreData event from server
                socket.on('MoreData', async (data) => {
                    try {
                        place = data.Place;
                        const percent = data.Percent;
                        
                        logger.debug('Received MoreData', { place, percent, fileName: file.name });
                        
                        if (uploadedSize < file.size) {
                            const start = place * 524288;
                            const end = Math.min(start + chunkSize, file.size);
                            const slice = file.slice(start, end);
                            const buffer = await slice.arrayBuffer();
                            const binaryString = Array.from(new Uint8Array(buffer))
                                .map(byte => String.fromCharCode(byte))
                                .join('');
                            
                            uploadedSize = end;
                            
                            socket.emit('Upload', { 
                                Name: file.name, 
                                Data: binaryString 
                            });
                        }
                    } catch (error) {
                        logger.error('Error in MoreData handler', error);
                        upload.classList.remove("uploading");
                    }
                });
                
                // Handle Done event from server
                socket.once('Done', (data) => {
                    try {
                        logger.info('Upload completed', { fileName: file.name, imagePreview: data.Image ? 'available' : 'none' });
                        upload.classList.remove("uploading");
                        uploadFilename.innerText = `${file.name} - Uploaded!`;
                        
                        // Reset after delay
                        setTimeout(() => {
                            location.reload();
                        }, 3000);
                    } catch (error) {
                        logger.error('Error in Done handler', error);
                    }
                });
                
                // Handle Error event from server
                socket.once('Error', (error) => {
                    try {
                        logger.error('Upload error', error);
                        upload.classList.remove("uploading");
                        uploadFilename.innerText = `Error: ${error.message}`;
                    } catch (err) {
                        logger.error('Error in Error handler', err);
                    }
                });
                
            } catch (error) {
                logger.error('Error starting upload', error);
                upload.classList.remove("uploading");
            }
        });
    }
}

// Drop stuff
const dropArea = document.querySelector('.drop-area');
['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, preventDefaults, false);
});

function preventDefaults(e) {
    e.preventDefault();
    e.stopPropagation();
}

// Add dropArea bordering when dragging a file over the body
['dragenter', 'dragover'].forEach(eventName => {
    body.addEventListener(eventName, displayDropArea, false);
});

['dragleave', 'drop'].forEach(eventName => {
    body.addEventListener(eventName, hideDropArea, false);
});

['dragenter', 'dragover'].forEach(eventName => {
    dropArea.addEventListener(eventName, highlight, false);
});

['dragleave', 'drop'].forEach(eventName => {
    dropArea.addEventListener(eventName, unhighlight, false);
});

function highlight(e) {
    if (!dropArea.classList.contains('highlight'))
        dropArea.classList.add('highlight');
}

function unhighlight(e) {
    dropArea.classList.remove('highlight');
}

function displayDropArea() {
    if (!dropArea.classList.contains('highlight'))
        dropArea.classList.add('droppable');
}

function hideDropArea() {
    dropArea.classList.remove('droppable');
}

// Handle dropped files
dropArea.addEventListener('drop', handleDrop, false);

function handleDrop(e) {
    try {
        let dt = e.dataTransfer;
        let files = dt.files;
        let file = files[0];
        if (file) {
            uploadFile(file);
        }
    } catch (error) {
        logger.error('Error handling drop', error);
    }
}

// Socket connection events
socket.on('connect', () => {
    logger.info('Connected to server', { socketId: socket.id });
});

socket.on('disconnect', () => {
    logger.warn('Disconnected from server');
});

socket.on('connect_error', (error) => {
    logger.error('Connection error', error);
});

// Simple logger for client-side
const logger = {
    info: (message, data = {}) => {
        console.log(`[INFO] ${message}`, data);
    },
    warn: (message, data = {}) => {
        console.warn(`[WARN] ${message}`, data);
    },
    error: (message, error = {}) => {
        console.error(`[ERROR] ${message}`, error);
    },
    debug: (message, data = {}) => {
        console.log(`[DEBUG] ${message}`, data);
    }
};
