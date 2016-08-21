/**
 * Module dependencies.
 */

var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var Avrgirl = require('avrgirl-arduino');

var SerialPort = require('serialport');

var slip = require('slip');

var ArduinoScanner = require('arduino-scanner');

/**
 * Constructor
 * Available option parameters:
 * @param {Object} opts - Options for consumer to pass in
 * @param {Boolean} opts.debug - Whether debug output should be printed to stdout
 * @param {Boolean} opts.silly - Whether extremely verbose output should be printed to stdout.
 *                               Requires that debug is enabled.
 * @param {Number} opts.baudrate - Baudrate to use (defaults to 57600)
 * @param {String} opts.port - Strict matching to a specific serial port (ex. /dev/tty/USBArduino)
 * @param {String} opts.serialNumber - Strict matching for a specifc serial number
 * @param {String} opts.board - Board type (defaults to mega)
 * @param {Boolean} opts.nmea - Whether to append NMEA checksums to sent messages
 * @param {Boolean} opts.binary - Whether we are expecting the serial input to be binary
 * @param {Boolean} opts.nmea - Whether to expect an acknowledgment after writing a message (binary only)
 * @param {String} opts.startChar - The starting char when sending NMEA string messages (not binary)
 */
var Arduino = function (opts) {
  var self = this;

  EventEmitter.call(self);

  opts = opts || {};

  self.options = {
    debug: opts.debug || false,
    // Extremely verbose debug messages
    silly: opts.silly || false,
    baudrate: opts.baudrate || 57600,
    // Whether we are expecting the serial input to be in binary
    binary: opts.binary || false,
    // Whether to expect an acknowledgment after writing a message (binary only)
    acknowledgment: opts.acknowledgment || false,
    // Strict matching for a specific serial port
    port: opts.port,
    // Strict matching for a specifc serial number
    serialNumber: opts.serialNumber,
    // The starting char when sending NMEA string messages
    startChar: opts.startChar || '$',
    // Restricts matching if defined
    board: opts.board || 'mega',
    nmea: opts.nmea || false
  };


  self.debug = self.options.debug ? function (message) {
    console.log('Arduino: ' + message);
  } : function () {};

  self.silly = self.options.silly ? self.debug : function () {};

  self.serialPort = undefined;

  // Is arduino-interface currently trying to have a conneciton with an arduino
  self.isConnected = false;

  // Is arduino-interface currently rebooting the arduino
  self.isRebooting = false;

  // Is avrgirl-arduino currently flashing the arduino
  self.isFlashing = false;

  // Is arduino-scanner currently looking for the arduino
  self.isScanning = false;

  self.arduinoScanner = new ArduinoScanner({
    board: self.options.board,
    port: self.options.port,
    serialNumber: self.options.serialNumber,
    debug: self.options.debug
  });

  self.arduinoScanner.on('arduinoNotFound', function (response) {
    self.debug(response.message);
  });

  self.arduinoScanner.on('arduinoFound', function (response) {
    self.arduinoScanner.stop();
    self.isScanning = false;
    self.debug(response.message);
    self._connectToArduino(response.port);
  });

  self.on('send-error', function() {
    self._writeAndWaitForAcknowledgementHelper();
  });

  self.decoder = new slip.Decoder({
    onMessage: self._parseBinaryMessage.bind(self)
  });

  self.sequenceNumber = 0;
  self.lastReceivedSequenceNumber = 0;
  self.sequenceNumberMax = 255;
  self.defaultAcknowledgmentOptions = {
    timeout: 2000, // milliseconds
    priority: 'high', // 'high' or 'low'
    attempts: 10
  };
  self.failedSequenceNumber = [];

  self.messageQueue = [];
  self.writing = false;
  self.timeout = null;
  self.fails = 0;
  self.maxFails = 100;
};

util.inherits(Arduino, EventEmitter);

/**
 * Scan for the arduino by checking all the ports, then connect to it and hold
 * the serial port connection.
 *
 * @param interval - how frequently the pi should scan for the arduino in the
 * USB ports
 */
Arduino.prototype.connect = function (interval) {
  var self = this;

  // If already trying to connect, then exit out.
  if (self.isScanning) {
    return;
  }

  self.isScanning = true;

  self.isConnected = true;

  interval = interval || 500;

  // Ensure that the arduion isn't being flashed, trying to connect during
  // this process will result in very bad things!
  self.connectInterval = setInterval(function () {
    if (!self.isFlashing) {
      self.debug('Starting Search.');
      self.arduinoScanner.start(interval);
      clearInterval(self.connectInterval);
    } else {
      self.debug('Flashing, postponing search.');
    }
  }, interval);
};

Arduino.prototype._parseStringMessage = function (message) {
  if (self.options.nmea && message[0] === '$') {
    // Checking for the '$' allows non-NMEA'd messages to go through unharmed

    // Get checksum
    var checksum = message.trim().substr(-2);

    // Get rid of checksum and starting character
    message = message.substring(1, message.length - 4);
    var computedChecksum = self._computeChecksum(message);

    if (checksum !== computedChecksum) {
      self.emit('error', {
        error: 'Checksum error',
        receivedChecksum: checksum,
        calculatedChecksum: computedChecksum,
        receivedMessage: message
      });
      return;
    }
  }
  self.emit('data', message);
};

Arduino.prototype._parseBinaryMessage = function (message) {
  var self = this;
  if (self.options.nmea) {
    // Get checksum
    var checksum = message[message.length - 1];
    // Get rid of checksum in main message
    message = message.slice(0, -1);

    var computedChecksum = self._computeChecksum(message);

    if (checksum !== computedChecksum) {
      self.emit('error', {
        error: 'Binary Checksum error',
        receivedChecksum: checksum,
        calculatedChecksum: computedChecksum,
        receivedMessage: String(message)
      });

      return;
    }
  }

  if (self.options.acknowledgment) {
    // expecting an acknowledgment bit. If the message is of size 1, check if it matches the sequence number
    // of the message we expect
    if (message.length === 1 && self.messageQueue[0] && message[0] === self.messageQueue[0].sequenceNumber) {
      self.silly('Acknowledgment byte successfully received: ' + message[0]);
      clearTimeout(self.timeout);
      const msg = self.messageQueue.shift();
      self.fails = 0;
      self.writing = false;
      msg.cb();
      self._writeAndWaitForAcknowledgementHelper();
      return;
    }
  }

  self.emit('data', message);
};

/**
 * Connect and open the arduino located at the given port.
 * Contains the event listeners for the serial port (they have to be here
 * since this is where serialPort is instantiated properly)
 *
 * @param port - the port emitted by arduino-scanner ex. /dev/tty/USBArduino
 */
Arduino.prototype._connectToArduino = function (port) {
  var self = this;
  var parser = self.options.binary ? SerialPort.parsers.raw : SerialPort.parsers.readline('\n');

  self.selectedPort = port;

  self.serialPort = new SerialPort(self.selectedPort, {
    baudRate: self.options.baudrate,
    parser: parser
  });

  self.serialPort.on('open', function () {
    if (!self.isFlashing) {
      self.reboot(function () {
        self.emit('connect');
      });
    }
  });

  if (self.options.binary) {
    self.serialPort.on('data', function (message) {
      self.decoder.decode(message);
    });
  } else {
    self.serialPort.on('data', function (message) {
      self._parseStringMessage(message);
    });
  }


  self.serialPort.on('close', function () {
    self.serialPort = undefined;
    self.emit('disconnect');
    if (self.isConnected) {
      self.connect();
    }
  });

  self.serialPort.on('error', function (err) {
    self.emit('error', err);
    // Close the port if it's still open
    // In this context |this| is the serialport
    if (this.isOpen()) {
      this.close();
    }
  });
};

Arduino.prototype.isOpen = function () {
  return this.serialPort !== undefined;
};


Arduino.prototype.disconnect = function (cb) {};

/**
 * Stop searching for an arduino or close the connection if it exists.
 *
 * @param cb(err) - Called once the arduino disconnected (or at failure)
 */
Arduino.prototype.disconnect = function (cb) {
  var self = this;

  if (self.isFlashing) {
    return cb(new Error(
      'The arduino is in the process of flashing, disconnect failed.'
    ));
  }

  self.isConnected = false;

  self.isScanning = false;

  clearInterval(self.connectInterval);
  self.arduinoScanner.stop();

  if (self.serialPort && self.serialPort.isOpen()) {
    self.serialPort.close(cb);
  }
};

/**
 * Flash the arduino. The docs say there is no need to specify a port, but if
 * you do need to, that it should be another parameter under board, called
 * port. First we will close the serial connection, then flash, then reopen it.
 *
 * @param hexLocation - The string of the location of the hex file
 * @param command - A command sent to the arduino before flashing
 * @param timeout - How many ms to wait after sending the command before flash
 * @param cb(err) - Called once the arduino is flashed (or at failure)
 */
Arduino.prototype.flashArduino = function (hexLocation, command, timeout, cb) {
  var self = this;

  if (self.isFlashing) {
    return cb(new Error('Already being flashed.'));
  }

  self.isFlashing = true;

  self.debug('Flash.');

  command = command || '';
  timeout = timeout || 1;

  self.writeAndDrain(
    command,
    function (err) {
      // We want to flash regardless of successfully sending the command
      if (err) {
        self.debug(err);
      }

      // Flash the arduino after the timeout has completed.
      // Don't close it before the timeout because closing it will reset the
      // arduino.
      setTimeout(function () {
        var flash = function (err) {
          self._performArduinoFlash(hexLocation, cb);
        };

        if (self.serialPort && self.serialPort.isOpen()) {
          self.serialPort.close(flash);
        } else {
          flash();
        }
      }, timeout);
    }
  );
};

Arduino.prototype._performArduinoFlash = function (hexLocation, cb) {
  var self = this;

  self.debug('Flashing.');

  var avrgirl = new Avrgirl({
    board: self.options.board,
    port: self.selectedPort,
    debug: self.options.debug
  });

  var filepath = path.resolve(process.cwd(), hexLocation);
  avrgirl.flash(filepath, function (err) {
    self.isFlashing = false;

    if (!err) {
      self.debug('Flashed successfully.');
    } else {
      self.debug('Flash failed.');
    }
    cb(err);
  });
};


/**
 * If the arduino is acting up and we want to reboot it. The callback function
 * will be activated once it has finished.
 *
 * @param cb - callback
 */
Arduino.prototype.reboot = function (cb) {
  var self = this;

  if (self.isFlashing) {
    return cb(new Error(
      'The arduino is in the process of flashing, reboot failed.'
    ));
  }

  if (!self.isRebooting && self.serialPort) {
    self.isRebooting = true;

    var reset = function (err) {
      if (err) {
        self.isRebooting = false;
        cb();
      }

      self.debug('Rebooting.');
      self.serialPort.set({
        rts: true,
        dtr: true
      }, function (err) {
        setTimeout(function clear() {
          self.serialPort.set({
            rts: false,
            dtr: false
          }, function (err) {
            setTimeout(function done() {
              self.debug('Reboot complete.');
              self.isRebooting = false;
              cb();
            }, 50);
          });
        }, 250);
      });
    };

    if (!self.serialPort.isOpen()) {
      self.serialPort.open(reset);
    } else {
      reset();
    }
  } else {
    return cb(new Error('Arduino serial port is not open, cannot reboot it.'));
  }
};

Arduino.prototype._computeChecksum = function (message) {
  var self = this;
  // Compute the checksum by XORing all the character values in the string.
  var checksum = 0;

  for (var i = 0; i < message.length; i++) {
    checksum = checksum ^ (self.options.binary ? message[i] : message.charCodeAt(i));
  }

  if (!self.options.binary) {
    // Convert it to hexadecimal (base-16, upper case, most significant nybble
    // first).
    checksum = Number(checksum).toString(16).toUpperCase();
    if (checksum.length < 2) {
      checksum = ('00' + checksum).slice(-2);
    }
  }


  return checksum;
};

/**
 * Write to the arduino and waits for the acknowledgment bit to be returned. Currently only has support
 * for binary sending.
 * @param message {Buffer} - Binary buffer with message to send
 * @param cb {Function} - Callback
 * @param options {Object} - Options for sending
 * @param options.attempts {Number} - Number of times to re-attempt sending. Default is 10.
 *                                    0 means won't send.
 * @param options.priority {String} - Priority: 'high' or 'low'
 * @param options.timeout {Number} - Amount of time to wait for acknowledgment before resending. Default is 200 ms
 */
Arduino.prototype.writeAndWaitForAcknowledgement = function (message, cb = () => {}, options) {
  var self = this;

  if (!self.options.binary) {
    return cb('Non-binary mode not currently supported for writeAndWaitForAcknowledgment function');
  }

  options = Object.assign({}, self.defaultAcknowledgmentOptions, options);

  if (self.messageQueue.length > 0 && options.priority === 'low') {
    // We won't bother waiting to send messages with low priority.
    self.emit('error', {
      message: 'Acknowledgment byte not yet received for previous message. Low priority message discarded'
    });

    self.messageQueue.shift();

    cb();
    return;
  }

  const sequenceNumber = self.sequenceNumber;
  message = Buffer.concat([message, new Buffer([sequenceNumber])]);
  self.sequenceNumber = self.messageQueue.push({message, cb, options, sequenceNumber});
  self._writeAndWaitForAcknowledgementHelper();
};

/**
 * Write to the arduino and waits for the acknowledgment bit to be returned. Currently only has support
 * for binary sending.
 * @param message {Buffer} - Binary buffer with message to send
 * @param callback {Function} - Callback
 * @param options {Object} - Options for sending
 * @param options.attempts {Number} - Number of times to re-attempt sending. Default is 10.
 *                                    0 means won't send.
 * @param options.priority {String} - Priority: 'high' or 'low'
 * @param sequenceNumber {Number} - The sequence number of the message we are sending. Used internally. Do not set.
 * @param options.timeout {Number} - Amount of time to wait for acknowledgment before resending. Default is 200 ms
 */
Arduino.prototype._writeAndWaitForAcknowledgementHelper = function () {
  var self = this;

  if (self.messageQueue.length === 0) {
    return;
  }

  const {message, cb, options} = self.messageQueue[0];
  const messageObj = self.messageQueue[0];

  if (options.attempts < 0) {
    // run out of attempts
    self.emit('error', {
      error: 'Acknowledgment byte not received after max attempts. Not retrying message',
      sequenceNumber: messageObj.sequenceNumber
    });

    return;
  }

  if (self.writing) {
    return;
  }
  self.writing = true;

  self.writeAndDrain(message, function (err) {
    if (err) {
      self.writing = false;
      self.fails++;
      if (self.fails > self.maxFails) {
        self.emit('error', {
          error: 'Arduino write failed 100 times. Wiping buffer!'
        });
        self.fails = 0;
        self.messageQueue = [];
      }

      clearTimeout(self.timeout);
      if (options.priority === 'low') {
        self.emit('error', {
          error: 'Arduino write failed. Low priority message discarded',
          sequenceNumber: message.sequenceNumber
        });
        cb('error: low priority message discarded');
        self.messageQueue.shift();
      } else {
        self.messageQueue[0].options.attempts -= 1;
      }
      self.emit('send-error');
      return;
    }

    self.timeout = setTimeout(function () {
      self.writing = false;
      self.fails++;
      if (self.fails > self.maxFails) {
        self.emit('error', {
          error: 'Arduino write failed 100 times. Wiping buffer!'
        });
        self.fails = 0;
        self.messageQueue = [];
      }

      if (options.priority === 'low') {
        self.emit('error', {
          error: 'Acknowledgment byte not received. Low priority message discarded',
          sequenceNumber: messageObj.sequenceNumber
        });
        cb('error: low priority message discarded');
        self.messageQueue.shift();
      } else if (self.messageQueue[0]) {
        self.messageQueue[0].options.attempts -= 1;
      }
      self.emit('send-error');
    }, options.timeout);

  });
};

/**
 * Writes to arduino and waits for it to finish transmitting before calling the
 * cb.
 *
 * @param message - The data to send to the arduino
 * @param cb(err) - Callback fired after drain
 */
Arduino.prototype.writeAndDrain = function (message, cb) {
  var self = this;
  var checksum;
  message = message || '';

  if (self.options.nmea) {
    if (self.options.binary) {
      checksum = new Buffer([self._computeChecksum(message)]);
      message = Buffer.concat([message, checksum]);
      // SLIP Encode
      message = slip.encode(message);
    } else {
      checksum = self._computeChecksum(message);
      message = '$' + message + '*' + checksum + '\r';
    }
  }


  if (!self.serialPort || !self.serialPort.isOpen) {
    cb(new Error('Serial port not open.'));
  } else {
    self.silly('Writing: ' + message);
    self.serialPort.write(message, function (err) {
      if (err) {
        self.emit('error', {
          message: 'Serial write error',
          error: err
        });
        return cb(err);
      }
      self.serialPort.drain(cb);
    });
  }
};

module.exports = Arduino;
