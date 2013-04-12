
var gammu = require('node-gammu-json');
var server = gammu.create({ interval: 0 });

server.on({
  receive: function (_message, _callback) {
    this.send(_message.from, _message.content, function (_m, _result) {
      console.log('transmit:', _result);
    });
    console.log('receive:', _message);
    _callback();
  }
}).start();

