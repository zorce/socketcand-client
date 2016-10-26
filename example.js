const cand = require('./socketcand');

cand.on('connected', function(conn) {
	console.log("connected", conn);
	cand.sendFrame(conn.id, '66', 4, 'DEADBEEF')
});

cand.on('disconnected', function() {
	console.log("disconnected");
});

cand.on('connectionPoints', function(points) {
	console.log("connection point received", points);
	const url = points[0].url;
	const bus = points[0].buses[0].name;
	const fullUrl = url+'/'+bus;

	cand.connect(fullUrl, cand.Mode.RAW);
});

