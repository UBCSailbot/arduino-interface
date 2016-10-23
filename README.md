# ArduinoInterface
An NPM module which makes it easy to safely interface with your Arduino over serial.
It allows you to safely update it too.  Great for remote mission critical deployments.

It has two modes: Binary mode and String mode.

Binary mode supports SLIP encoding, checksums, and one-way (computer-to-arduino) message confirmation checking for extremely robust communication.

String mode supports NMEA checking to make sure that your messages are received correctly.

## Usage
Get it through NPM by running: `npm install arduino-interface`

## Node Version
Compatible with node 6.x

### Troubleshooting
If your Arduino isn't being detected, you may need to add the productId to the boards.js file in [arduino-scanner](https://github.com/UBCSailbot/arduino-scanner). If this happens, please make a pull request to that repo have the boards.js updated so we can improve the module!

### Basic Usage Example

```node
var Arduino = require('arduino-interface');
var arduino = new Arduino({
  baudrate: 9600, // default is 57600
  nmea: true,
  debug: true
});

// Connect to the Arduino
// This will start searching for an Arduino and connect to it once one is found
arduino.connect();

arduino.on('connect', function() {
  console.log('Arduino connected.');
});
arduino.on('disconnect', function() {
  console.log('Arduino serial connection closed. It will try to be reopened.');
});
arduino.on('data', function(message) {
  console.log('Data received: ' + message);
});
```

### Binary Mode Example
```node
var Arduino = require('arduino-interface');
var arduino = new Arduino({
                    baudrate: 57600,
                    binary: true,
                    acknowledgment: true,
                    nmea: true, // this adds a checksum and byte stuffing with SLIP
                    debug: true,
                  });

var options = {
  attempts: 20, // Number of times to re-attempt sending. Default is 10.
  priority: 'high', // 'high' or 'low'. Message re-attempts only occur if priority 'high'
  timeout: 300 // Amount of time to wait for acknowledgment before resending. Default is 200 ms
};

var data = Buffer.from("this will be a binary message");
arduino.writeAndWaitForAcknowledgement(data, writeCallback, options);
```

`writeAndWaitForAcknowledgment` will add the message to a queue of messages to send. This ensures that the messages
are sent in a proper order. Only if a message succeeds to send and gets an acknowledgement, or fails
to send after the amount of times specified in the "attempts" will it be dequeued.

The checksum is calculated by the XOR of each byte of your message, and is the very last byte of the message (before being SLIP encoded).

The acknowledgment byte is added automatically by this library if `acknowledgment` is true, and is the sequence number of the message in the queue.
It is added to the end of the message, before the checksum (and so is included in the checksum). This byte must be sent back from the Arduino
within the allotted `timeout` field in the `options` object or else the acknowledgment will have been considered a fail and the message will be resent.
Note that the acknowledgment byte sent back must also be SLIP encoded and have a checksum if `nmea` is enabled.

We recommend using the excellent [Packet Serial](https://github.com/bakercp/PacketSerial) library for Arduino
SLIP support, and adding your own checksum checker and acknowledgment sender on top of that
(we may release our own implementation at a later date).

We recommend [Google's Protobuf](https://github.com/google/protobuf) tool to serialize your data, but any serial encoding/decoding should work.

When Binary Mode is enabled, all incoming messages will be run through a SLIP decoding before being surfaced by `arduino.on('data', () => {})`,
so make sure that your Arduino encodes the data with SLIP before sending it back (can use the above Packet Serial for that as well).

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

#### .writeAndWaitForAcknowledgement(data, writeCallback, options)
Write to the arduino and waits for the acknowledgment byte to be returned. Currently only has support
for Binary Mode, so the data must be a Buffer.

var options = {
  attempts: 20, // Number of times to re-attempt sending. Default is 10.
  priority: 'high', // 'high' or 'low'. Message re-attempts only occur if priority 'high'
  timeout: 300 // Amount of time to wait for acknowledgment before resending. Default is 200 ms
};

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
