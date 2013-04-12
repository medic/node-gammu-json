
var gammu = require('node-gammu-json');
var server = gammu.create({ interval: 2 });

server.on({
  receive: function (_message, _callback) {
    this.send(_message.from, _message.content, function (_e, _m, _r) {
      console.log('transmit callback:', _e, _r);
    });
    console.log('receive:', _message);
    _callback();
  },

  transmit: function (_message, _result) {
    console.log('transmit:', _message, _result);
  },

  error: function (_error, _message) {
    console.log('error:', _error, _message);
  }
}).start();

