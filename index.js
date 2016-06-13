/**
 * Module dependencies.
 */

var util = require('util');
var path = require('path');
var EventEmitter = require('events').EventEmitter;

var Avrgirl = require('avrgirl-arduino');

var serialport = require('serialport');
var SerialPort = serialport.SerialPort;

var ArduinoScanner = require('arduino-scanner');

/**
 * Constructor
 *
 * @param {Object} options Options for consumer to pass in
 */
var Arduino = function(opts) {
  var self = this;

  EventEmitter.call(self);

  opts = opts || {};

  self.options = {
    debug: opts.debug || false,
    baudrate: opts.baudrate || 57600,
    board: opts.board || 'mega',
    nmea: opts.nmea || false
  };

  self.debug = self.options.debug ? function(message) {
    console.log('Arduino: ' + message);
  } : function() {};

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
    debug: self.options.debug
  });

  self.arduinoScanner.on('arduinoNotFound', function(response) {
    self.debug(response.message);
  });

  self.arduinoScanner.on('arduinoFound', function(response) {
    self.arduinoScanner.stop();
    self.isScanning = false;
    self.debug(response.message);
    self._connectToArduino(response.port);
  });
};

util.inherits(Arduino, EventEmitter);

/**
 * Scan for the arduino by checking all the ports, then connect to it and hold
 * the serial port connection.
 *
 * @param interval - how frequently the pi should scan for the arduino in the
 * USB ports
 */
Arduino.prototype.connect = function(interval) {
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
  self.connectInterval = setInterval(function() {
    if (!self.isFlashing) {
      self.debug('Starting Search.');
      self.arduinoScanner.start(interval);
      clearInterval(self.connectInterval);
    } else {
      self.debug('Flashing, postponing search.');
    }
  }, interval);
};

/**
 * Connect and open the arduino located at the given port.
 * Contains the event listeners for the serial port (they have to be here
 * since this is where serialPort is instantiated properly)
 *
 * @param port - the port emitted by scan.js, likely /dev/tty/USBArduino
 */
Arduino.prototype._connectToArduino = function(port) {
  var self = this;

  self.serialPort = new SerialPort(port, {
    baudrate: self.options.baudrate,
    parser: serialport.parsers.readline("\n")
  });

  self.serialPort.on('open', function() {
    if (!self.isFlashing) {
      self.reboot(function() {
        self.emit('connect');
      });
    }
  });

  self.serialPort.on('data', function(message) {
    self.emit('data', message);
  });

  self.serialPort.on('close', function() {
    self.serialPort = undefined;
    self.emit('disconnect');
    if (self.isConnected) {
      self.connect();
    }
  });

  self.serialPort.on('error', function(err) {
    self.emit('error', err);
    if (self.serialPort.isOpen()) {
      self.serialPort.close();
    }
  });
};

Arduino.prototype.isOpen = function() {
  return this.serialPort !== undefined;
}

/**
 * Stop searching for an arduino or close the connection if it exists.
 *
 * @param cb(err) - Called once the arduino disconnected (or at failure)
 */
Arduino.prototype.disconnect = function(cb) {
  var self = this;

  if (self.isFlashing) {
    return cb(new Error('The arduino is in the process of flashing, disconnect failed.'));
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
Arduino.prototype.flashArduino = function(hexLocation, command, timeout, cb) {
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
    function(err) {
      // We want to flash regardless of successfully sending the command
      if (err) {
        self.debug(err);
      }

      // Flash the arduino after the timeout has completed.
      // Don't close it before the timeout because closing it will reset the
      // arduino.
      setTimeout(function() {
        var flash = function(err) {
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

Arduino.prototype._performArduinoFlash = function(hexLocation, cb) {
  var self = this;

  self.debug('Flashing.');

  var avrgirl = new Avrgirl({
    board: self.options.board,
    debug: self.options.debug
  });

  var filepath = path.resolve(process.cwd(), hexLocation);
  avrgirl.flash(filepath, function(err) {
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
Arduino.prototype.reboot = function(cb) {
  var self = this;

  if (self.isFlashing) {
    return cb(new Error('The arduino is in the process of flashing, reboot failed.'));
  }

  if (!self.isRebooting && self.serialPort) {
    self.isRebooting = true;

    var reset = function(err) {
      if (err) {
        self.isRebooting = false;
        cb();
      }

      self.debug('Rebooting.');
      self.serialPort.set({
        rts: true,
        dtr: true
      }, function(err) {
        setTimeout(function clear() {
          self.serialPort.set({
            rts: false,
            dtr: false
          }, function(err) {
            setTimeout(function done() {
              self.debug("Reboot complete.");
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

/**
 * Writes to arduino and waits for it to finish transmitting before calling the
 * cb.
 *
 * @param message - The data to send to the arduino
 * @param cb(err) - Callback fired after drain
 */
Arduino.prototype.writeAndDrain = function(message, cb) {
  var self = this;

  message = message || '';

  if (self.options.nmea) {
    // Compute the checksum by XORing all the character values in the string.
    var checksum = 0;
    for (var i = 0; i < message.length; i++) {
      checksum = checksum ^ message.charCodeAt(i);
    }

    // Convert it to hexadecimal (base-16, upper case, most significant nybble
    // first).
    var hexsum = Number(checksum).toString(16).toUpperCase();
    if (hexsum.length < 2) {
      hexsum = ("00" + hexsum).slice(-2);
    }

    message = '$' + message + '*' + hexsum + '\r';
  }

  if (!self.serialPort || !self.serialPort.isOpen) {
    cb(new Error('Serial port not open.'));
  } else {
    self.debug('Writing: ' + message);

    self.serialPort.write(message, function() {
      self.serialPort.drain(cb);
    });
  }
};

module.exports = Arduino;
