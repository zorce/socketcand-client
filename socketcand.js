const shortid = require('shortid');
const util = require("util");
const EventEmitter = require('events');
const net = require('net');
const urlM = require('url');
const dgram = require('dgram');
const bs = dgram.createSocket('udp4');
const parseString = require('xml2js').parseString;

var bsPoints = [];
var lastBsPoints = [];

bs.on('listening', () => {
	var address = bs.address();
	//console.log(`socketcand-client listening ${address.address}:${address.port}`);
});

bs.on('error', (err) => {
	//console.log(`server error:\n${err.stack}`);
	bs.close();
	return new Error("Server error:\n${err.stack}");
});

bs.on('message', (msg, rinfo) => {
	parseString(msg, function(err, result) {
		var buses = []
                for (bus in result.CANBeacon.Bus) {
			buses.push({name:result.CANBeacon.Bus[bus].$.name.trim()});
		}
		var obj = {
			host:result.CANBeacon.$.name.trim(),
			url:result.CANBeacon.URL[0].trim(),
			buses:buses
		}

		var idx = bsPoints.findIndex(x => x.host==obj.host)
		if (idx === -1) {
			// new
			bsPoints.push(obj);
		} else {
			// roplace
			bsPoints[idx] = obj;
		}
		emitBsPoints();
	});
});

function emitBsPoints() {
	if (lastBsPoints != bsPoints) {
		lastBsPoints = bsPoints;
		module.exports.emit('connectionPoints', bsPoints);
	}
}

bs.bind(42000);

function getConnectionPoints() {
	return bsPoints;
}

var activeConnections = [];

module.exports = new EventEmitter();

const Mode = {
	BCM: 0,
	RAW: 1,
	ISOTP: 2
};

var state = null;

function getConnectionFromId(sockId) {
	for (i in activeConnections) {
		if (sockId == activeConnections[i].id) {
			return activeConnections[i];
		}
	}
	return undefined;
}

function connect(urlString, mode) {
	const parsedUrl = urlM.parse(urlString, true, true);
	const protocol = parsedUrl.protocol;
	const hostname = parsedUrl.hostname;
	const port = parsedUrl.port;
	const iface = parsedUrl.path.replace(/\//, "");	

	if (protocol != "can:") {
		return new Error("Wrong protocol in url only accept 'can:'");
	}

	const scc = net.connect(port, hostname, function() {
		//module.exports.emit('connected');
	});

	scc['url'] = urlString;
	scc['id'] = shortid.generate();

	activeConnections.push(scc);

	// TODO rawdata sometimes bundled multiple < ok > etc in same frame, split and loop!
	scc.on('data', function(rawdata) {
		var data = rawdata.toString();
		module.exports.emit('data', data);
		if (data == '< hi >') {
			scc.write('< open '+iface+' >');
			state = Mode.BCM;
			channelMode(this['id'], mode);
			module.exports.emit('connected', {url:this['url'], id:this['id']});
		} else if (data == "< ok >") {
		} else if (data.match(/<\sframe.+>/i)) {
			const m = data.match(/<\sframe\s([0-9a-fA-F]+)\s(\d+).(\d+)\s+([0-9a-fA-F]*\s?)*\s>/);
			if (m) {
				const frame = {
					id: m[1],
					sec: m[2],
					usec: m[3],
					data: m[4],
					bus: iface,
					url: this['url'],
					sockId: this['id'],
					mode: state
				};
				module.exports.emit('frame', frame)
			} else {
				return new Error("Error could not parse received frame, protocol inconsistency");
			}
		} else {
			// TODO handle this better!
			console.log('Unknown command received ' + data.toString());
		}
	});
	
	scc.on('connected', function(conn) {
		//module.exports.emit('connected', {url:this['url'], id:this['id']});
	});	
	
	scc.on('close', function(conn) {
		module.exports.emit('disconnected', {url:this['url'], id:this['id']});
	});

	return scc['id'];
}

function disconnect(sockId) {
	for (i in activeConnections) {
                if (sockId == activeConnections[i].id) {
			activeConnections[i].destroy();
			activeConnections.splice(i, 1);
		}
	}
}

function channelMode(sockId, mode) {
	if (state == null) {
		return new Error("Unknown state");
	}
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (mode == Mode.BCM && state != Mode.BCM) {
		scc.write('< bcmmode >');
		state = Mode.BCM;
	} else if (mode == Mode.RAW && state != Mode.RAW) {
		scc.write('< rawmode >');
		state = Mode.RAW;
	} else if (mode == Mode.ISOTP && state != Mode.ISOTP) {
		scc.write('< isotpmode >');
		state = Mode.ISOTP;
	} else {
		return state;
	} 
}

function addFrame(sockId, id, sec, usec, dlc, data) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< add '+sec+' '+usec+' '+id+' '+dlc+' '+data+' >');
	} else {
		return new Error("Cannot add frame, wrong state");
	}
}

function updateFrame(sockId, id, dlc, data) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< update '+id+' '+dlc+' '+data+' >');
	} else {
		return new Error('ERROR cannot update frame, wrong state');
	}
}

function deleteFrame(sockId, id) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< delete '+id+' >');
	} else {
		return new Error('ERROR cannot delete frame, wrong state');
	}
}

function sendFrame(sockId, id, dlc, data) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM ||
	    state == Mode.RAW) {
		data = data.replace(/ /g,''); // remove whitespace
		data = data.replace(/(.{2})/g,"$1 ") // insert whitespace every second
		scc.write('< send '+id+' '+dlc+' '+data+' >');
	} else {
		return new Error('ERROR cannot send frame, wrong state');
	}
}

function filter(sockId, id, sec, usec, dlc, mask) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< filter '+id+' '+sec+' '+usec+' '+dlc+' '+mask+' >');
	} else {
		return new Error('ERROR cannot filter, wrong state');
	}
}

function subscribe(sockId, id, sec, usec) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< subscribe '+sec+' '+usec+' '+id+' >');
	} else {
		return new Error('ERROR cannot subscribe, wrong state');
	}
}

function unsubscribe(sockId, id) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.BCM) {
		scc.write('< unsubscribe '+id+' >');
	} else {
		return new Error('ERROR cannot unsubscribe, wrong state');
	}
}

function echo(sockId) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state) {
		scc.write('< echo >');
	} else {
		return new Error('ERROR no open channel');
	}
}

// up to stmin is mandatory
function isotpConfig(sockId, txid, rxid, flags, blocksize, stmin, wftmax, txpad, rxpad, extAddr, rxExtAddr) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.ISOTP) {
                var str = '< isotpconf '+txid+' '+rxid+' '+
                        flags+' '+blocksize+' '+stmin;
                if (wftmax != undefined) {
                        str += ' '+wftmax;
                }
                if (txpad != undefined) {
                        str += ' '+txpad;
                }
                if (rxpad != undefined) {
                        str += ' '+rxpad;
                }
                if (extAddr != undefined) {
                        str += ' '+extAddr;
                }
                if (rxExtAddr != undefined) {
                        str += ' '+rxExtAddr;
                }
                str += ' >';

		scc.write(str);
	} else {
		return new Error('ERROR cannot change isotp config, wrong state');
	}
}

function sendPdu(sockId, data) {
	const scc = getConnectionFromId(sockId);
	if (scc == undefined) {
		return new Error("Socket not found for id " + sockId);
	}

	if (state == Mode.ISOTP) {	
		data = data.replace(/ /g,''); // remove whitespace
		scc.write('< sendpdu '+data+' >');
	} else {
		return new Error('ERROR cannot send pdu, wrong state');
	}
}

module.exports.Mode = Mode;
module.exports.getConnectionPoints = getConnectionPoints;
module.exports.connect = connect;
module.exports.disconnect = disconnect;
module.exports.channelMode = channelMode;
module.exports.addFrame = addFrame;
module.exports.updateFrame = updateFrame;
module.exports.deleteFrame = deleteFrame;
module.exports.sendFrame = sendFrame;
module.exports.filter = filter;
module.exports.subscribe = subscribe;
module.exports.unsubscribe = unsubscribe;
module.exports.echo = echo;
module.exports.isotpConfig = isotpConfig;
module.exports.sendPdu = sendPdu;


