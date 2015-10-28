# ArduinoInterface
An NPM module which makes it easy to safely interface with your Arduino over serial.
It allows you to safely update it too.  Great for remote mission critical deployments.

Want to make sure that your messages are received correctly? No problem! NMEA checksums are supported natively!

## Usage
Get it through NPM by running: `npm install arduino-interface`

### Troubleshooting
Node 0.12.X is required until the `serialport` module is updated.

**Node 4.0 is NOT supported at this time.**

### Usage Example

```node
var Arduino = require('arduino-interface');
var arduino = new Arduino({
  nmea: true,
  debug: true
});

// Connect to the Arduino
// This will start searching for an Arduino and
arduino.connect();

arduino.on('connect', function() {
  console.log('Arduino connected.');
});
arduino.on('disconnect', function() {
  console.log('Arduino serial connection closed. Trying to reopen.');
});
arduino.on('data', function(message) {
  console.log('Data received: ' + message);
});
```

## Reference Guide
### Constructor
Search for an Arduino and connect once it's found.

You can search for any known Arduino types, or specify a kind of board.

Check `arduino-scanner`'s `boards.js` for valid board names.

```node
var arduino = new Arduino({
  board: 'mega' // Restrict search to a specific board type if you'd like!
                // Note that some boards share productIds
                // This is optional!

  nmea: true,   // This is great if you want to ensure that the message is
                // received properly. Prepends the message with '#' and appends
                // a '*' and XOR checksum (Google NMEA for more information)

  debug: true   // Print potentially useful debug output.
  });
```
### Methods
#### .connect ()
Starts scanning for valid Arduino serial ports.
It will emit an `connect` event once a serial connection has been opened.

##### interval
The time in milliseconds before trying port reads again.
The default is `500ms`.

#### .disconnect (callback)
Stop scanning for Arduinos or close the connection if it exists.

**Warning:** It is very unsafe to do this while the Arduino is flashing so it
will call the callback with an error if this is attempted.

#### .flashArduino (hexLocation, command, timeout, callback)
Flash the Arduino. The docs say there is no need to specify a port, but if
you do need to, that it should be another parameter under board, called
port. First we will close the serial connection, then flash, then reopen it.

##### hexLocation
The string of the location of the hex file.
##### command
A command sent to the Arduino before flashing. Useful for certain applications.
##### timeout
How many ms to wait after sending the command before flash.
##### callback(err)
Called once the Arduino is flashed (or at failure).

#### .reboot (callback)
If the Arduino is acting up and we want to reboot it. The callback function
will be activated once it has finished.

##### cb(err)
Callback fired after reboot

**Warning:** It is very unsafe to do this while the Arduino is flashing so it
will call the callback with an error if this is attempted.

#### .writeAndDrain (message, callback)
Writes to Arduino and waits for it to finish transmitting before calling the cb.

If the NMEA option was set to true then this message will be sent in accordance
with the NMEA protocol.

##### message
The data to send to the Arduino.
##### callback(err)
Callback fired after drain.

### Events
#### .on('connect', callback)
Emitted once a serial connection is opened with a detected Arduino.

#### .on('disconnect', callback)
Emitted if the serial connection is closed.

#### .on('data', callback)
Passes an string to the callback containing a message received over serial.

#### .on('error', callback)
Emitted if a serialport error occurs.

## Cool projects that use this
### [UBC Sailbot](http://ubcsailbot.org/)
A fully autonomous sailboat that will be crossing the Atlantic Ocean Summer 2016.
This module enables us to remotely update the boat code, and send telemetry data
to a central server for [live viewing online](http://track.ubctransat.com/).

### Others
Add your own! Submit a pull request :)

## Currently supported boards
+ Arduino Uno
+ Arduino Mega
+ Arduino Leonardo
+ Arduino Micro
+ Arduino Nano
+ Arduino Duemilanove
+ Arduino Pro Mini
+ Femtoduino IMUduino
+ Blend-Micro
+ Tinyduino
+ Sparkfun Mega Pro
+ Sparkfun Pro Micro
+ Qtechknow Qduino
+ Pinoccio Scout

## Thanks
Thanks to the `node-serialport` and `avrgirl-arduino` teams for doing a lot of the backbone work.

## License
MIT
