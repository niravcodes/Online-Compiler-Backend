//todo:
// break down the codebase
// write better DDOS protections
// client slde repsonsivity that's not limited to vanilla alerts
// make alerts seem friendly and witty, that's the way you impress people.
// if not in real life then in software. (sedlyf)
// Rework the compiler to emit correct return values on exit.
//
// Messages sent and received by websockets
// 	1. toolongsincelasttalk : user has been inactive for `max_inactive_time`
// 	2. toomanyconnections : The microserver can't take any more connections
// 	3. status			: sends some data when connection successfully initiated.
//  4. codesend			: Client sends code to be compiled
//  5. assemblysend		: send generated assembly to cliend
//  6. outputsend	    : send generated output to cliend
//  7. inputsend  		: client has sent some input for us.

var express = require("express");
var bodyParser = require("body-parser");
var app = express();
var server = require('http').Server(app);
var io = require('socket.io')(server, { serveClient: false, maxHttpBufferSize: 6000 }); // max size accepted ~ 6kB
var cors = require('cors')
const { exec, spawn } = require('child_process');
const fs = require('fs-extra');

app.use(cors({ origin: 'http://code.nirav.com.np', credentials: true }))
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

//serverwide constants
const max_connections = 600;
var cur_connections = 0;
const max_codesend_per_min = 20;
const max_inactive_time = 6;

var logstream = fs.createWriteStream("log", {flags:'a'});
function logwrite(str, ip){
	logstream.write (new Date().toISOString() + " : " + ip + " " + str + '\n\n')
}

io.on('connection', function (socket) {
	var cur_codesend = 0;
	var mins_passed_since_last_codesend = 0;

	setInterval(() => {
		cur_codesend = 0;
		mins_passed_since_last_codesend += 1;
		if (mins_passed_since_last_codesend >= max_inactive_time) {
			socket.emit('toolongsincelasttalk');
			socket.disconnect(true);
		}
	}, 60000) // One minute

	var id = socket.id;
	if (cur_connections >= max_connections) {
		socket.emit('toomanyconnections');
		logwrite ("Denied Connection because too many", socket.request.connection.remoteAddress)
		socket.disconnect(true);
		return 0;
	}
	else {
		cur_connections += 1;
		logwrite (cur_connections + "connections happening now\nLatest Connector: "+socket.id, socket.request.connection.remoteAddress);
	}

	var directory = "/mnt/resource/" + id;
	console.log(id)
	socket.emit('status', { status: 'conn' });

	socket.on('disconnect', () => {
		cur_connections -= 1;
		if (cur_connections < 0) cur_connections = 0; // for weird acync errors
		logwrite(id + "disconnects", socket.request.connection.remoteAddress);
		fs.remove(directory)
	})


	var previous_code = ""; // If previous code and currently sent code are the same, don't recompile
	socket.on('codesend', (data) => {
		cur_codesend += 1;
		if (cur_codesend >= max_codesend_per_min) {
			return 0;
		}

		var code = data.code;
		if (code === "") return console.log("empty");
		if (previous_code === code) execute_user_binary();
		else {
			previous_code = code;
			start_from_scratch();
		}

		function start_from_scratch() {
			fs.mkdirp(directory, err2 => {
				if (err2) {
					return console.log(err2)
				}


				fs.writeFile(directory + "/code.sakshyar", code, function (err1) {
					if (err1) {
						return console.log(err1);
					}
					console.log(id + " code saved");


					const compiler = exec('bin/sakshyar ' + directory + '/code.sakshyar', (e, out, err) => {
						socket.emit('assemblysend', { assembly: out });

						fs.writeFile(directory + "/a.asm", out, (err) => {
							if (err) { return console.log(err); }

							const yasm = exec("yasm -f elf64 " + directory + "/a.asm -o " + directory + "/a.o ", (e, o, er) => {
								if (er) return console.log(err);

								const ld = exec('ld ' + directory + '/a.o bin/printf.o bin/stdio.o -o ' + directory + '/a.out', (err, our) => {
									if (err) return console.log(err);
									console.log(our);
									execute_user_binary();
									return 0;
								})
							})
						})
					});
				})
			});
		}

		function execute_user_binary() {
			var inputbuffer = "";

			const user_binary = spawn("bin/coderunner.sh", [directory + '/a.out']);
			console.log(id + " " + user_binary.pid);
			var running = true;

			user_binary.stdout.setEncoding('UTF-8')
			user_binary.stdout.on('data', (data) => {
				socket.emit('outputsend', { output: data });
			});
			user_binary.on('close', (a) => {
				if (a === 124) {
					socket.emit('outputsend', { output: "Programs can't run for more than 30 seconds.\n" });
				}
				else {
					socket.emit('outputsend', { output: '\nThe program has completed execution.\n' });
				}
				fs.remove(directory);
				running = false;
			})
			socket.on('inputsend', (data) => {
				if (running) {
					console.log(inputbuffer);
					if (data.data !== '\0') inputbuffer += data.data;
					else {
						console.log("data in: " + inputbuffer);
						user_binary.stdin.write(inputbuffer);
						inputbuffer = "";
					}
				}
			})
		}


	});
});

server.listen(80);
