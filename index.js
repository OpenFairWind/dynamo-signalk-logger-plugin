const Bacon = require("baconjs");
const debug = require("debug")("signalk:dynamo-signalk-logger-plugin");
const util = require("util");

const http = require('http')
const path = require('path')
const fs = require('fs')
const os = require("os");

// https://www.npmjs.com/package/concurrent-queue
const queue = require('concurrent-queue');

const request = require('request');
const { spawn } = require('child_process')

const crypto = require('crypto');
const zlib = require('zlib');

let constants = require("constants");

const uuidv1 = require('uuid/v1');
const { Transform } = require('stream');

let CircularBuffer = require("circular-buffer");


/*
 Define the plugin
 app - passed by the framework, is the reference to the application
*/
module.exports = function (app) {

  // Define the plugin object and the list of the Signal K update the plugin subscribes to
  let plugin = {
    // The plugin unique id
    id: 'dynamo-signalk-logger-plugin',

    // The plugin human-readable name
    name: 'SignalK DYNAMO Logger',

    // The plugin description
    description: 'Plugin that logs data on DYNAMO cloud',

    // Subscribes
    unsubscribes: []
  }



  // check the available memory
  const pluginDir = os.homedir() + "/.signalk/plugin-config-data/"+plugin.id;

  // Check if the pluginDir exists
  if (!fs.existsSync(pluginDir)) {
    // Create the pluginDir
    fs.mkdirSync(pluginDir, { recursive: true });
  }

  const baseKeyFilename = pluginDir + "/vessels." + app.selfId

  // Check if the privateKeyFilename exists
  if (!fs.existsSync(baseKeyFilename + ".pem")) {

    // Calling generateKeyPair() method
// with its parameters
    crypto.generateKeyPair('rsa', {
      modulusLength: 2048,    // options
      publicExponent: 0x10101,
      publicKeyEncoding: {
        type: 'pkcs1',
        format: 'pem'
      },
      privateKeyEncoding: {
        type: 'pkcs8',
        format: 'pem'
      }
    }, (err, publicKey, privateKey) => { // Callback function
      if(!err)
      {
        // Write the private key
        fs.writeFileSync(baseKeyFilename + ".pem", privateKey);

        // Write the public key
        fs.writeFileSync(baseKeyFilename + "-public.pem", publicKey);
      }
      else
      {
        // Prints error
        console.log("Errr is: ", err);
      }

    });
  }


  //  This class is needed for encryption
  class PrependedEncryptedSymmetricKey extends Transform {
    constructor(encryptedSymmetricKey, opts) {
      super(opts);
      this.encryptedSymmetricKey = encryptedSymmetricKey;
      this.prepended = false;
    }

    _transform(chunk, encoding, cb) {
      if (!this.prepended) {
        this.push(this.encryptedSymmetricKey+"\n");
        this.prepended = true;
      }
      this.push(chunk);
      cb();
    }
  }

  //  This class is needed for encryption
  class PrependSignature extends Transform {
    constructor(signature, opts) {
      super(opts);
      this.signature = signature;
      this.prepended = false;
    }

    _transform(chunk, encoding, cb) {
      if (!this.prepended) {
        this.push(JSON.stringify(this.signature)+"\n");
        this.prepended = true;
      }
      this.push(chunk);
      cb();
    }
  }

  //  This class is needed for encryption
  class AppendInitVect extends Transform {
    constructor(initVect, opts) {
      super(opts);
      this.initVect = initVect;
      this.appended = false;
    }

    _transform(chunk, encoding, cb) {
      if (!this.appended) {
        this.push(this.initVect);
        this.appended = true;
      }
      this.push(chunk);
      cb();
    }
  }

  // logError - log error on the application logging system or on the console
  const logError =
    app.error ||
    (err => {
      console.error(err)
    })

  // debug - write debug messages on the application debug log or on the console
  const debug =
    app.debug ||
    (msg => {
      console.log(msg)
    })



  // Upload status
  let uploadStatus = "undefined"

  // Signal K self identifier
  let selfId = ""

  // The server url
  let serverUrl = ""

  // Directory for logging (where the plugin stores the updates)
  let logDir = ""

  // Directory for storage (where the plugin stores locally the log files)
  let storageDir = ""

  // Directory for files waiting for upload
  let uploadDir = ""

  // The name of the log file
  let logFileName = "data_log.json"

  // The log file is cut each seconds
  let logRotationInterval = 300

  // The plugin trys to upload each seconds
  let uploadInterval = 60

  // Private key path
  let privateKeyPath=""

  // Public key path
  let serverPublicKeyPath=""

  // Number of concurrently uploading threads
  let threads = 1

  // Latest speed in byte per second
  let latestSpeed = 0

  // Latest time of speed measurement
  let latestTime

  // Get the file size in bytes
  function getFilesizeInBytes(filename) {
    const stats = fs.statSync(filename)
    return stats.size
  }

  let uploadSpeedBuffer = new CircularBuffer(100);
  for (let i=0; i<100; i++) {
    uploadSpeedBuffer.push({"size": 0, "start": 0, "stop": 0, "threads": 0, "speed": 0})
  }

  // The upload queue
  let uploadQueue = queue().limit({ concurrency: threads }).process(function (filePath, done) {
    console.log(`Uploading: ${filePath} -> ${serverUrl}/upload`)

    let startTime = Date.now()
    let req = request.post(serverUrl+"/upload/vessels."+selfId, function (err, resp, body) {
      if (err) {
        console.log(`Error!:${err}`);
        uploadStatus = { "text": "error", "error": err }
      } else {
        console.log('Body: [' + body+']');

        let stopTime= Date.now()
        let fileSize=getFilesizeInBytes(filePath)
        let speed = fileSize/((stopTime-startTime)/1000)
        uploadSpeedBuffer.push(
          {"size":fileSize,"start":startTime,"stop":stopTime, "threads": uploadQueue.concurrency, "speed": speed})

        latestSpeed = speed
        latestTime = stopTime
        console.log("Speed: "+latestSpeed+" b/s at "+ new Date(latestTime))

        fs.unlinkSync(filePath);
        uploadStatus = { "text": "ok"}
      }
    });

    let sessionId=uuidv1();
    let form = req.form();
    form.append('sessionId',sessionId)
    form.append('file', fs.createReadStream(filePath));
    done();
  })



  // The plugin schema representing metadata and settings
  plugin.schema = {
    type: "object",
    title: "DYNAMO Logger",
    description: "Log Signal K data as delta objects into DYNAMO cloud.",
    properties: {
      serverUrl: {
        type: 'string',
        title: 'Server URL',
        default: 'http://localhost:5000'
      },
      serverLogin: {
        type: 'string',
        title: 'Server Login',
        default: ''
      },
      serverPass: {
        type: 'string',
        title: 'Server Password',
        default: ''
      },
      logDir: {
        type: 'string',
        title: 'Data log file directory',
        default: pluginDir+"/log"
      },
      storageDir: {
        type: 'string',
        title: 'Storage directory.',
        default: pluginDir+"/storage"
      },
      uploadDir: {
        type: 'string',
        title: 'Upload directory',
        default: pluginDir+"/upload"
      },
      interval: {
        type: 'number',
        title: 'Log rotation interval (in seconds). Value of zero disables log rotation.',
        default: 300
      },
      uploadInterval: {
        type: 'number',
        title: 'Upload interval (in seconds). Value of zero disables upload.',
        default: 60
      },
      privateKeyPath: {
        type: 'string',
        title: 'Private key path (this device).',
        default: baseKeyFilename + ".pem"
      },
      serverPublicKeyPath: {
        type: 'string',
        title: 'Server public key path.',
        default: ''
      }
    }
  }

  /*
  Generate a random password of given lenght
   */
  function generatePassword(length) {
    let text = "";
    let possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

    for (let i = 0; i < length; i++)
      text += possible.charAt(Math.floor(Math.random() * possible.length));

    return text;
  }


  /*
  Rotate the log file (invoked by the timer each logRotationInterval seconds
  time - the current datetime in UTC
   */
  function rotateLogFile(time) {
    console.log("rotateLogFile:"+time)


    // Create a new log file name
    logFileName = "sk-delta-log.".concat(time.toISOString()).concat('.log')

    // This function returns true if the file name passed as fileName ends with .log
    function hasLogExtension(fileName) {
      // Get the file extension
      let fileExt = path.extname(fileName);
      // Return true if the extension is .loh
      return fileExt === '.log';
    };

    // Read the directory log dir invoking the function when finished
    // fileList is a list with all directory entries
    fs.readdir(logDir, function(err, fileList) {

      // For each element of the fileList having .log as extension invoke the function
      // logFile is the i-th directory entry having the .log extension
      fileList.filter(hasLogExtension).forEach(function(logFile) {
        // Check if the logFIle is not the currently used logFileName
        if (logFile !== logFileName) {

          // GZip the log file in the storage directory
          console.log("GZIP: "+logDir + "/" + logFile+" -> "+storageDir + "/" + logFile + ".gz")

          // Create the gzip object
          const gzip = zlib.createGzip();

          // Create the write-stream
          const writeStream = fs.createWriteStream(storageDir + "/" + logFile + ".gz");

          // Create the read-stream
          const readStream = fs.createReadStream(logDir + "/" + logFile);

          // Handle the end event
          readStream.on("end", function(){

            // Sign the data

            // Create a read stream
            const hashReadStream = fs.createReadStream(logDir + "/" + logFile);

            // Handle the end event
            fs.readFile(logDir + "/" + logFile, 'utf8', function(err, data) {

              /* Summary:
              Definition:
              Sender - the client application running on the vessel side
              Receiver - the server application running on the cloud side

              Key exchange:
              At the setup time, the user registers the vessel on the DYNAMO web portal providing the automatically
              generated vessel's UUID or the MMSI and the sender_priv_key using a secured channel (i.e. https server
              portal or APIs). The receiver_pub_key is downloaded via https and stored locally.
              This is done only one time, usually at home, on the boatyard or docked in a marina.

              1. Read the parcel
              2. Create a digital signature RSA-SHA256
              3. Sign the parcel using the sender_priv_key, encode the signature in Base64
              4. Set the signature as { "seflId":uuId, "signature": ..., "type":"RSA-SHA256" }
              5. Generate a symmetric key
              6. Encrypt the symmetric key with the receiver_pub_key (padding RSA_PKCS1_OAEP_PADDING)
              7. Generate a 16 values random integer as initialization vector
              8. Prepend the signature
              9. Compress the parcel and the prepended signature
              10.Encrypt the parcel using symmetric key (aes-256-cbc)
              11.Append the init vector1
              12.Prepend the Encrypted Symmetric Key

               */


              // The signature
              let sig=null
              let type="RSA-SHA256"


              try {
                // Read the source private key
                let srcPem = fs.readFileSync(privateKeyPath);
                let srcKey = srcPem.toString('ascii');
                //console.log(srcKey)
                // Create the signature object
                let srcSign = crypto.createSign(type);

                // Encrypt using the srcKey
                srcSign.update(data);
                sig = srcSign.sign(srcKey, 'base64');

              } catch (err) {
                type="none"
              }

              // Generate a symmetric key
              const symmetricKey= generatePassword(32)
              console.log("Symmeric Key:"+symmetricKey)

              // Read the destination public key
              let dstPem = fs.readFileSync(serverPublicKeyPath);
              let dstKey = dstPem.toString('ascii');
              //console.log(dstKey)
              let buffer = Buffer.from(symmetricKey);

              let encrypted = crypto.publicEncrypt(
                { "key" : dstKey,
                  "padding" : constants.RSA_PKCS1_OAEP_PADDING
                },
                buffer);

              let encryptedSymmetricKey=encrypted.toString("base64");
              console.log("encryptedSymmetricKey:"+encryptedSymmetricKey)


              const prependEncryptedSymmetricKey = new PrependedEncryptedSymmetricKey(encryptedSymmetricKey);

              // Read the signature
              let signature = { "selfId":selfId,"signature":sig,"type":type }
              const prependSignature = new PrependSignature(signature);

              console.log("signature:" + JSON.stringify(signature))

              // Create write stream with a different file extension
              const writeStream = fs.createWriteStream(uploadDir + "/" + logFile + ".gz.enc");

              // Create the gzip object
              const gzip = zlib.createGzip();

              // Generate a secure, pseudo random initialization vector.
              const iv = crypto.randomBytes(16);
              console.log("iv:")
              console.log(iv)

              // Generate a cipher key from the sharedSecret.
              const cipherKey = crypto.createHash('sha256').update(symmetricKey).digest()

              // for symmetric encryption
              //aes256
              const cipher = crypto.createCipheriv('aes-256-cbc', cipherKey, iv);
              const appendInitVect = new AppendInitVect(iv);

              // Create a read stream
              const readStream = fs.createReadStream(logDir + "/" + logFile);

              // Handle the end event
              readStream.on("end",function () {
                console.log("Deleting:" + logDir + "/" + logFile)
                fs.unlinkSync(logDir + "/" + logFile);
              })

              // Perform the encryption process
              readStream
                // Prepend signature JSON
                .pipe(prependSignature)

                // GZip the file
                .pipe(gzip)

                // Encrypt the file
                .pipe(cipher)

                // Append the init vector
                .pipe(appendInitVect)

                // Prepend the Encrypted Symmetric Key
                .pipe(prependEncryptedSymmetricKey)

                // Finally write the stream
                .pipe(writeStream)
            });
          })

          // Perform the gzip process
          readStream
            // GZio the file
            .pipe(gzip)

            // Finally write the stream
            .pipe(writeStream)
          }
      })
    })
  }

  /*
  Try to upload enc files to the cloud
   */
  function tryUpload() {
    console.log("tryUpload")

    // This function returns true if the file name passed as fileName ends with .enc
    function hasEncExtension (fileName) {

      // Get the file extension
      let fileExt = path.extname(fileName);

      // Return true if the file extension is .enc
      return fileExt === '.enc';
    };

    // Read the directory uploadDir invoking the function function when finished
    // fileList is a list with all directory entries
    fs.readdir(uploadDir, function (err, fileList) {

      // For each element of the fileList having .enc as extension invoke the function
      // encFile is the i-th directory entry having the .enc  extension
      fileList.filter(hasEncExtension).forEach(function (encFile) {

        console.log(`Enqueue: ${encFile}`)
        uploadQueue(uploadDir + "/" + encFile)
      })
    })
  }

  // Append the delta to the current log file
  function writeDelta(delta) {
    // Append to the file
    fs.appendFile(

      // Create the file path
      path.join(logDir, logFileName),

      // Dumps the json to a string
      JSON.stringify(delta).concat("\n"), (err) => {
        if (err) throw err;
      }
    )
  }

  /*
  Define the start function (invoked by the framework when the plugin have to be started)
  options - passed by the framework, has the properties defined in plugin.schema.properties
  */
  plugin.start = function (options) {

    // Check if the logDir is defined, but the directory doesn't exist
    if (options["logDir"] !== "" && !fs.existsSync(options["logDir"])) {
      fs.mkdirSync(options["logDir"], { recursive: true });
    }

    // Check if the logDir is defined, but the directory doesn't exist
    if (options["storageDir"] !== "" && !fs.existsSync(options["storageDir"])) {
      fs.mkdirSync(options["storageDir"], { recursive: true });
    }

    // Check if the logDir is defined, but the directory doesn't exist
    if (options["uploadDir"] !== "" && !fs.existsSync(options["uploadDir"])) {
      fs.mkdirSync(options["uploadDir"], { recursive: true });
    }

    // Check if the server public key is available
    if (options["serverUrl"] !== "" && options["serverPublicKeyPath"] === "") {
      // Download the server public key

      const url = options["serverUrl"]+"/publickey"
      const filename = pluginDir + "/server-public.pem";

      http.get(url, (res) => {
        const fileStream = fs.createWriteStream(filename);
        res.pipe(fileStream);

        fileStream.on('finish', () => {
          fileStream.close();
          console.log('Download finished')
          options["serverPublicKeyPath"] = filename
        });
      })

    }

    if (
      // Check if the logDir is not empty and exists on the file system
      options["logDir"] !== "" && fs.existsSync(options["logDir"]) &&

      // Check if the storageDir is not empty and exists on the file system
      options["storageDir"] !== "" && fs.existsSync(options["storageDir"]) &&

      // Check if the uploadDir is not empty and exists on the file system
      options["uploadDir"] !== "" && fs.existsSync(options["uploadDir"]) &&

      // Check if the interval is not empty and if it is greater than zero
      options["interval"] !== "" && options["interval"]>0 &&

      // Check if the uploadInterval is not empty and if it is greater or equal than zero
      options["uploadInterval"] !== "" && options["uploadInterval"]>=0 &&

      // Check if the serverUrl is not empty
      options["serverUrl"] !== ""

    ) {

      // Save the Signal K self identifier
      selfId=app.selfId

      // Read directory settings
      logDir = options["logDir"]
      storageDir = options["storageDir"]
      uploadDir = options["uploadDir"]

      // Read interval settings
      logRotationInterval = options["interval"]

      // Read the upload interval
      uploadInterval = options["uploadInterval"]

      // Read the upload URL
      serverUrl=options["serverUrl"]

      // Read the private key path
      privateKeyPath=options["privateKeyPath"]

      // Read the public key path
      serverPublicKeyPath=options["serverPublicKeyPath"]


      // create a new logfile
      rotateLogFile(new Date())

      // Dump the full document as delta
      writeDelta(makeFullDelta())

      // Set a timer each logRotationInterval seconds invoking the rotateLogFile function
      setInterval(() => {

          // Rotate the log file
          rotateLogFile(new Date())

          // Dump the full document as delta
          writeDelta(makeFullDelta())
        },
        logRotationInterval * 1000
      )


      // Check if the uploadInterval is greater than zero
      if (uploadInterval > 0) {
        // Set a timer each uploadInterval seconds invoking the tryUpload function
        setInterval(() => {

            // Try to upload
            tryUpload()
          },
          uploadInterval * 1000
        )
      }

      // Handle the signalk delta event
      app.signalk.on('delta', (delta) => {
        try {
          //console.log(delta)

          // Write the delta to the current log file
          writeDelta(delta)
        } catch ( err ) {
          console.error(err)
        }
      })

      // Create an update form the full document
      function makeFullDelta() {

        // Set the context
        const context = "vessels." + app.selfId

        // Get the whole document
        let doc = app.getPath(context)

        // Initialize the result
        let delta = {
          "updates": [
            {
              "timestamp": new Date(),
              "values": [],
              "$source": "defaults"
            }
          ],
          "source": { "label" :"dynamo-signalk-logger-plugin", "type": "dynamo-signalk-logger-plugin"},
          "context": context
        }

        // Set an empty path
        let signakPath = [];

        // Set an empty dictionary for the root properties
        let rootProperties = {};

        // Recursive function for document visiting
        function eachRecursive(obj) {

          // For each key in the object
          for (let key in obj) {

            // Add the key to the path
            signakPath.push(key)

            // Check if the object is an object, if the key is not null,
            // and if the key is not "value"
            if (typeof obj[key] == "object" && obj[key] !== null && key !== "value") {

              // Invoke the same function recursively
              eachRecursive(obj[key]);

            } else {
              // Create the path sting from all path elements except the last
              let pathString = signakPath.slice(0, -1).join('.')

              // Check if the current key is "value"
              if (key === "value") {

                // Prepare a full path to get the value
                let fullPathString = context + "." + pathString + ".value"

                // Set the value object
                let value = {
                  "path": pathString,
                  "value": app.getPath(fullPathString)
                }

                // Add the value to the updates' values
                delta.updates[0].values.push(value)

              } else
                // Check if the path string is empty
                if (pathString === "") {
                  // Add the document root property to the rootProperties dictionary
                  rootProperties[key] = obj[key]
              }
            }

            // Remove the last path element
            signakPath.pop()
          }
        }

        // Invoke the recursive function
        eachRecursive(doc)

        // Set the value object for the root properties
        let value = {
          "path": "",
          "value": rootProperties
        }

        // Add the root properties to the delta
        delta.updates[0].values.push(value)

        console.log("Full Delta:")
        console.log(JSON.stringify(delta))

        // Return the delta
        return delta
      }

    } else {
      console.log("The DYNAMO Logger is not correcly configured:\n"+JSON.stringify(options))
    }
  }

  /* Register the REST API */
  plugin.registerWithRouter = function(router) {

    // Return the logging speed
    router.get("/info", (req, res) => {
      app.debug("get info")

      let result = {
        "timeref": latestTime,
        "status": uploadStatus,
        "speed": {
          "buffer": uploadSpeedBuffer.toarray(),
          "latest": latestSpeed
        },
        "queue": {
          "concurrency": uploadQueue.concurrency,
          "pending": uploadQueue.pending.length,
          "upload": fs.readdirSync(uploadDir).length,
          "processing": uploadQueue.processing.length
        },
        "logfile": {
          "name": logFileName,
          "size": fs.statSync(path.join(logDir, logFileName)).size
        }
      }

      res.status(200)
      res.send(result)
    })

    // Return the logs
    router.get("/logs", (req, res) => {
      app.debug("get logs")

      let logs = []

      fs.readdirSync(logDir).forEach(file => {
        let stats = fs.statSync(path.join(logDir,file))

        let item = {
          "name": file,
          "size": stats.size,
          "date": new Date(stats.birthtime)
        }
        logs.push(item)
      });

      res.status(200)
      res.send(logs)
    })

    // Return the uploads
    router.get("/uploads", (req, res) => {
      app.debug("get uploads")

      let uploads = []

      fs.readdirSync(uploadDir).forEach(file => {
        let stats = fs.statSync(path.join(uploadDir,file))

        let item = {
          "name": file,
          "size": stats.size,
          "date": new Date(stats.birthtime)
        }
        uploads.push(item)
      });

      res.status(200)
      res.send(uploads)
    })

    // Return the storage
    router.get("/storage", (req, res) => {
      app.debug("get storage")

      let storage = []

      fs.readdirSync(storageDir).forEach(file => {
        let stats = fs.statSync(path.join(storageDir,file))

        let item = {
          "name": file,
          "size": stats.size,
          "date": new Date(stats.birthtime)
        }
        storage.push(item)
      });

      res.status(200)
      res.send(storage)
    })
  }

  /*
  Define the stop function (invoked by the framework when the plugin have to be stopped)
  */
  plugin.stop = function () {

    // Rotate the current log file
    rotateLogFile(new Date())

    // Try to upload
    tryUpload()

    // Unsubscribe each handle
    plugin.unsubscribes.forEach(f => f())

    // Empty the subscribers list
    plugin.unsubscribes = []
  }

  // Return the plugin object
  return plugin

}
