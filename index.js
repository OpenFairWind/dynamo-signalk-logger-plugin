const Bacon = require("baconjs");
const debug = require("debug")("signalk:signalk-data-logger");
const util = require("util");
const _ = require('lodash')
const path = require('path')
const fs = require('fs')
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

  // Define the plugin object and the list of the Signal K update the plugin subscribes to
  let plugin = {
    unsubscribes: []
  }

  // Signal K self identifier
  let selfId = ""

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
  let publicKeyPath=""

  // Number of concurrently uploading threads
  let threads = 2

  // Get the file size in bytes
  function getFilesizeInBytes(filename) {
    const stats = fs.statSync(filename)
    const fileSizeInBytes = stats.size
    return fileSizeInBytes
  }

  let uploadSpeedBuffer = new CircularBuffer(100);



  // The upload queue
  let uploadQueue = queue().limit({ concurrency: threads }).process(function (filePath, done) {
    console.log(`Uploading: ${filePath} -> ${uploadUrl}`)

    let startTime = Date.now()
    let req = request.post(uploadUrl+"/"+selfId, function (err, resp, body) {
      if (err) {
        console.log(`Error!:${err}`);
      } else {
        console.log('Body: [' + body+']');

        let stopTime= Date.now()
        let fileSize=getFilesizeInBytes(filePath)
        uploadSpeedBuffer.push(
          {"size":fileSize,"start":startTime,"stop":stopTime})
        // An array with the latest speed measurements
        let uploadSpeedArray=uploadSpeedBuffer.toarray();
        console.log("uploadSpeedBuffer:"+util.inspect(uploadSpeedArray, {showHidden: false, depth: null}))

        let t1=0
        uploadSpeedArray.forEach(item => {
          if (item["stop"]>t1) {
            t1=item["stop"]
          }
        })


        let t0=t1-1000;
        let speed=0
        uploadSpeedArray.forEach(item => {
          if (item["start"]>=t0 && item["stop"]<=t1) {
            speed += parseFloat(item["size"]);
          }
        })
        console.log("Speed: "+speed+" b/s")

        fs.unlinkSync(filePath);
      }
    });

    let sessionId=uuidv1();
    let form = req.form();
    form.append('sessionId',sessionId)
    form.append('file', fs.createReadStream(filePath));
    done();
  })

  // The plugin unique id
  plugin.id = 'signalk-dynamo-logger'

  // The plugin human readable name
  plugin.name = 'SignalK DYNAMO Logger'

  // The plugin description
  plugin.description =
    'Plugin that logs data on DYNAMO cloud'

  // The plugin schema representing metadata and settings
  plugin.schema = {
    type: "object",
    title: "DYNAMO Logger",
    description: "Log Signal K data as delta objects into DYNAMO cloud.",
    properties: {
      uploadurl: {
        type: 'string',
        title: 'Upload URL',
        default: 'http://localhost:5000/upload'
      },
      logdir: {
        type: 'string',
        title: 'Data log file directory',
        default: ''
      },
      storagedir: {
        type: 'string',
        title: 'Storage directory',
        default: ''
      },
      uploaddir: {
        type: 'string',
        title: 'Upload directory',
        default: ''
      },
      interval: {
        type: 'number',
        title: 'Log rotation interval (in seconds). Value of zero disables log rotation.',
        default: 300
      },
      uploadinterval: {
        type: 'number',
        title: 'Upload interval (in seconds). Value of zero disables upload.',
        default: 60
      },
      privatekeypath: {
        type: 'string',
        title: 'Private key path (this device).',
        default: ''
      },
      publickeypath: {
        type: 'string',
        title: 'Public key path (the DYNAMO Storage server).',
        default: ''
      }
    }
  }

  // Number of concurrent request theads
  plugin.threads=8

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

    // Read the directory log dir invoking the function function when finished
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

          // Create the write stream
          const writeStream = fs.createWriteStream(storageDir + "/" + logFile + ".gz");

          // Create the read stream
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
              let dstPem = fs.readFileSync(publicKeyPath);
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

              // Create a write stream with a different file extension
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




  // Appen the delta to the current log file
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
    if (
      // Check if the logdir is not empty and exists on the file system
      options["logdir"] !== "" && fs.existsSync(options["logdir"]) &&

      // Check if the storageDir is not empty and exists on the file system
      options["storagedir"] !== "" && fs.existsSync(options["storagedir"]) &&

      // Check if the uploadDir is not empty and exists on the file system
      options["uploaddir"] !== "" && fs.existsSync(options["uploaddir"]) &&

      // Check if the interval is not empty and if it is greater than zero
      options["interval"] !== "" && options["interval"]>0 &&

      // Check if the uploadinterval is not empty and if it is greater or equal than zero
      options["uploadinterval"] !== "" && options["uploadinterval"]>=0 &&

      // Check if the uploadurl is not empty
      options["uploadurl"] !== ""

    ) {

      // Save the Signal K self identifier
      selfId=app.selfId

      // Read directory settings
      logDir = options["logdir"]
      storageDir = options["storagedir"]
      uploadDir = options["uploaddir"]

      // Read interval settings
      logRotationInterval = options["interval"]
      uploadInterval = options["uploadinterval"]

      // Read the upload URL
      uploadUrl=options["uploadurl"]

      // Read the private key path
      privateKeyPath=options["privatekeypath"]

      // Read the public key path
      publicKeyPath=options["publickeypath"]


      // create a new logfile
      rotateLogFile(new Date())

      // Try to upload
      //tryUpload()


      // Set a timer each logRotationInterval seconds invoching the rotateLogFile function
      setInterval(() => {

          // Rotate the log file
          rotateLogFile(new Date())
        },
        logRotationInterval * 1000
      )


      // Check if the uploadInterval is greter than zero
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
    } else {
      console.log("The DYNAMO Logger is not correcly configured:\n"+JSON.stringify(options))
    }
  }

  /* Register the REST API */
  plugin.registerWithRouter = function(router) {
    console.log("registerWithRouter")

    // Return the logging status
    router.get("/status", (req, res) => {
      console.log("get.command: " + util.inspect(req.body))
      debug("command: " + util.inspect(req.body))
      console.log("get.command.done")
    })

    console.log("/registerWithRouter")
  }

  /*
  Define the stop function (invoked by the framework when the plugin havto to be stopped)
  */
  plugin.stop = function () {

    // Rotate the current log file
    rotateLogFile(new Date())

    // Try to upload
    tryUpload()

    // Unsubscribe each handle
    plugin.unsubscribes.forEach(f => f())

    // Empty the subscribers list
    unsubscribes = []
  }

  // Reryrb the plugub object
  return plugin

}
