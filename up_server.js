const image2base64 = require('image-to-base64');
const path = require('path');
const fs = require('fs');
const exec = require('child_process').exec;
const util = require('util');
  
if(!process.env['APP_PORT']){
	process.env['APP_PORT']	= 80;// __dirname;
}  
if(!process.env['APP_IP']){
	process.env['APP_IP']	= '';//'127.0.0.1';// __dirname;
}  
const { APP_PORT, APP_IP, APP_PATH, HOME } = process.env; 
const indexPath = path.join(__dirname + '/www/up.html');
const Files = {};

var app = require('http'); 
app = app.createServer(handler);

app.listen(APP_PORT, APP_IP, () => {
  console.log(`Server running at http://${APP_IP}:${APP_PORT}/`);
});

const io = require('socket.io')(app);


function handler (req, res) {
  fs.readFile( indexPath,
 // __dirname + '/www/up.html',
  function (err, data) {
    if (err) {
      res.writeHead(500);
      return res.end('Error loading index.html');
    }
    //res.wlriteHead(200);
    res.end(data);
  });
}

/**
**
**/
 String.prototype.file_type = function() {
        return this.split(".").pop();
}
function base64_encode(file) {	
	// read binary data
		var bitmap = fs.readFileSync(file);
	// convert binary data to base64 encoded string
		return new Buffer.from(bitmap).toString('base64');
}
/**
**
**/

io.sockets.on('connection', function (socket) {
	
/*

  switch (typeof(obj)) {
    case 'string':
     // log.console('STR'+obj);
      log.ansi('STR'+obj);
      break;
	case 'array':
      console.log('ARR'+obj);
      break;	
	case 'object':
     // console.log(obj.message + 'obj '+obj.code+' '+obj.path);
      break;
    default:
      console.log(`Say what? I might have heard '${obj}'`);
      break;
  }	
	*/
/** **/
  	socket.on('Start', function (data) { //data contains the variables that we passed through in the html file
			var Name = data['Name'];
			Files[Name] = {  //Create a new Entry in The Files Variable
				FileSize : data['Size'],
				Data	 : "",
				Downloaded : 0
			}
  
 // console.log(Files[Name].FileSize);
	
			var Place = 0;
			try{
				var Stat = fs.statSync('tmp/' +  Name);
				if(Stat.isFile())
				{
					Files[Name]['Downloaded'] = Stat.size;
					Place = Stat.size / 524288;
				}
			}
	  		catch(err){} //It's a New File
			fs.open("tmp/" + Name, 'a', 0755, function(err, fd){
				if(err)
				{
					console.log(err);
				}
				else
				{
					Files[Name]['Handler'] = fd; //We store the file handler so we can write to it later
					socket.emit('MoreData', { 'Place' : Place, Percent : 0 });
				}
			});
	});
	
	socket.on('Upload', function (data){
			var Name = data['Name'];
			Files[Name]['Downloaded'] += data['Data'].length;
			
//			console.log(data['Data']);
			
			Files[Name]['Data'] += data['Data'];
			if(Files[Name]['Downloaded'] == Files[Name]['FileSize']) //If File is Fully Uploaded
			{
				fs.write(Files[Name]['Handler'], Files[Name]['Data'], null, 'Binary', function(err, Writen){
					var inp = fs.createReadStream("tmp/" + Name);
					var out = fs.createWriteStream("Video/" + Name);
					//util.pump(inp, out, function(){
                inp.pipe(out);
                inp.on("end", function() {
					
                    console.log("end");
                    fs.unlink("/" + Name, function ()
                    { //This Deletes The Temporary File
                        console.log("unlink this file:",Name );
							//exec("ffmpeg -i Video/dock.mp4 -ss 01:30 -r 1 -an -vframes 1 -f mjpeg Video/dock.mp4.jpg", function(err){
							if(Name.file_type() == 'mp4') {
								exec("ffmpeg -i Video/" + Name  + " -ss 00:01 -r 1 -an -vframes 1 -f mjpeg Video/" + Name  + ".jpg", 
								function(err){
								
									var img = path.join(__dirname, "Video", Name  + ".jpg");
									
									var base64str = base64_encode(img);
																
								
								socket.emit('Done', {'Image' : base64str});					
									//	console.log(img);
										
// function to encode file data to base64 encoded string

								});
							
								

								}
								else {

								var base64str = base64_encode('file.png');//'file.png');
								//console.log(base64str);
								socket.emit('Done', {'Image' : base64str});
								}
					});
				});						
				});						
                        //socket.emit('Done', {'Image' : 'Video/' + Name + '.jpg'});
                        //socket.emit('Done', {'Image' : 'Video/' + Name + '.jpg'});

			}
			else if(Files[Name]['Data'].length > 10485760){ //If the Data Buffer reaches 10MB
				fs.write(Files[Name]['Handler'], Files[Name]['Data'], null, 'Binary', function(err, Writen){
					Files[Name]['Data'] = ""; //Reset The Buffer
					var Place = Files[Name]['Downloaded'] / 524288;
					var Percent = (Files[Name]['Downloaded'] / Files[Name]['FileSize']) * 100;
					socket.emit('MoreData', { 'Place' : Place, 'Percent' :  Percent});
				});
			}
			else
			{
				var Place = Files[Name]['Downloaded'] / 524288;
				var Percent = (Files[Name]['Downloaded'] / Files[Name]['FileSize']) * 100;
				socket.emit('MoreData', { 'Place' : Place, 'Percent' :  Percent});
			}
		});
});
