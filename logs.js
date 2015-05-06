var async = require('async');

var CloudWatchBuddyLogs = function(cloudwatchlogs, svc, options){

    var api = {};

    var _logs = {};
    var _logsToSend;

    var _existingLogStreams = {};   // Holds known streams and their sequence tokens
    var _queuedSize = {};           // bytes to upload for each stream

    var _uploadInterval;

    var _logGroup = options.logGroup;
    var _timeout = (options.timeout && typeof options.timeout === 'number' && options.timeout >= 60 && options.timeout <= 1800) ? options.timeout : 120;
    var _maxSize = (options.maxSize && typeof options.maxSize === 'number' && options.maxSize < 1048576 && options.maxSize > 5000) ? options.maxSize : 200000;  // Default upload size of 200KB, AWS max of 1,048,576 bytes
    var _logFormat = (options.logFormat && typeof options.logFormat === 'string' && (options.logFormat === 'string' || options.logFormat === 'json')) ? options.logFormat : 'string';
    var _addTimestamp = (options.addTimestamp && typeof options.addTimestamp === 'boolean') ? options.addTimestamp : false;
    var _addInstanceId = (options.addInstanceId && typeof options.addInstanceId === 'boolean') ? options.addInstanceId : false;
    var _debug = (options.debug && typeof options.debug === 'boolean') ? options.debug : false;

    var _instanceId = 'unknown';

    // If _addInstanceId is set, then request the instance ID from AWS
    if (_addInstanceId) {
        svc.request('/latest/meta-data/instance-id', function(err, data){
            if (err && _debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : ERROR : Error retrieving instance ID from AWS : ' + err); }
            if (!err && data) {
                if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Instance ID retrieved from AWS : ' + data); }
                _instanceId = data; // set the instance ID in the background during initiation
            }
        });
    }

    var putLogData = function() {
        clearInterval(_uploadInterval);

        if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Put logs called'); }
        // Copy the log object so logs saved during the upload process aren't lost
        _logsToSend = JSON.parse(JSON.stringify(_logs));    // copy; don't reference
        _logs = {};                                         // Reset the logs instantly so none are lost
        
        // Reset the queued sizes
        for (key in _logsToSend) {
            _queuedSize[key] = 0;
        }

        async.eachSeries(Object.keys(_logsToSend), function(stream, callback){

            if (!_logsToSend[stream].length) {
                return callback();    // go to the next one
            }

            checkIfLogStreamExistsAndCreateItIfItDoesNot(stream, function(err, data){
                if (err) {
                    if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : ERROR : Error checking if log stream exists : ' + err); }
                    callback(err);
                } else {
                    // Stream now exists
                    if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Log stream exists : ' + stream); }
                    var params = {
                        logEvents: _logsToSend[stream],
                        logGroupName: _logGroup,
                        logStreamName: stream,
                        sequenceToken: _existingLogStreams[stream]
                    };
                    cloudwatchlogs.putLogEvents(params, function(err, data){
                        if (err) {
                            if (err.code === 'InvalidSequenceTokenException') {
                                if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : InvalidSequenceTokenException from AWS, retrying : ' + err); }
                                params.sequenceToken = err.message.substring(err.message.indexOf(':') + 2);
                                cloudwatchlogs.putLogEvents(params, function(err, data){
                                    if (err) {
                                        // Still having issues
                                        if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : ERROR : Error putting logs : ' + err); }
                                        callback(err);
                                    } else {
                                        _existingLogStreams[stream] = data.nextSequenceToken;   // Set this for next time
                                        callback(err, data);
                                    }
                                });
                            } else {
                                if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : ERROR : Error putting logs : ' + err); }
                                callback(err);
                            }
                        } else {
                            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Successfully put logs for stream : ' + stream); }
                            _existingLogStreams[stream] = data.nextSequenceToken;   // Set this for next time
                            callback();
                        }
                    });
                }
            });
        }, function(err){
            if (err) {
                
            }
            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Finished putting logs. Resetting timer'); }
            setUploadInterval();    // Reset timer for next loop
        });
    };

    var checkIfLogStreamExistsAndCreateItIfItDoesNot = function(stream, callback) {
        if (_existingLogStreams[stream]) {
            callback();
        } else {
            var params = {
                logGroupName: _logGroup,
                logStreamNamePrefix: stream,
                limit: 1
            };
            cloudwatchlogs.describeLogStreams(params, function(err, data){
                if (!err && data.logStreams.length > 0) {
                    // The stream already exists, so add it to our known array and continue
                    // TODO: make sure the whole name matches, not just the prefix
                    _existingLogStreams[stream] = null; // Will eventually hold the sequence token
                    callback();
                } else {
                    // Create the stream
                    var params = {
                        logGroupName: _logGroup,
                        logStreamName: stream
                    };
                    cloudwatchlogs.createLogStream(params, callback);
                }
            });
        }
    };


    var setUploadInterval = function() {
        _uploadInterval = setInterval(function(){
            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Timer expired, calling put logs'); }
            putLogData();
        }, _timeout * 1000);
    };

    setUploadInterval();    // Call it first to start

    // Public functions

    api.log = function(stream, msg) {
        if (_logs[stream] === undefined) {
            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Adding new local log stream : ' + stream); }
            _logs[stream] = [];
        }

        if (_logFormat === 'string') {
            if (typeof msg === 'object') {
                msg = JSON.stringify(msg);
            }
            
            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Adding log string to local stream : ' + stream); }
            
            _logs[stream].push({
                timestamp: new Date().getTime(),
                message: (_addTimestamp ? new Date + ' ' : '') + (_addInstanceId ? _instanceId : '') + msg
            });
        } else {
            var logObj = {};
            if (_addTimestamp) { logObj['timestamp'] = new Date; }
            if (_addInstanceId) { logObj['instance_id'] = _instanceId; }
            logObj['message'] = msg;

            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Adding log JSON to local stream : ' + stream); }

            _logs[stream].push({
                timestamp: new Date().getTime(),
                message: JSON.stringify(logObj, null, 2)    // AWS only accepts a string
            });
        }

        _queuedSize[stream] += (26 + JSON.stringify(_logs[stream]).length * 2);    //~2 bytes per character plus 26 bytes of overhead per log
        
        if (((_queuedSize[stream]) >= (_maxSize - 1000)) || _logs[stream].length > 9000) {   // Leave some room (AWS max is 10,000 logs)
            if (_debug) { console.log (new Date() + ' : CloudWatchBuddyLogs : INFO : Size of log queue for stream ' + stream + ' ' + _queuedSize[stream] + ' bytes is greater than max size of ' + _maxSize + ' bytes'); }
            putLogData();
        }
    };

    return api;
}

module.exports = CloudWatchBuddyLogs;