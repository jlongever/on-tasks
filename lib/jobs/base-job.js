// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di');

module.exports = baseJobFactory;
di.annotate(baseJobFactory, new di.Provide('Job.Base'));
    di.annotate(baseJobFactory,
    new di.Inject(
        'Protocol.Events',
        'Services.Encryption',
        'Services.Lookup',
        'Services.Messenger',
        'Constants',
        'Assert',
        'Util',
        'Promise',
        'Result',
        '_'
    )
);
function baseJobFactory(
    eventsProtocol,
    encryption,
    lookup,
    messenger,
    Constants,
    assert,
    util,
    Promise,
    Result,
    _
) {
    function BaseJob(logger, options, context, taskId) {
        var self = this;
        assert.func(self._run);

        assert.object(logger);
        assert.uuid(taskId);
        assert.object(options);
        assert.object(context);

        self.subscriptions = [];
        self.subscriptionPromises = [];

        self.logger = logger;
        self.options = options;
        self.context = context;
        self.taskId = taskId;

        self._deferred = new Promise(function(resolve, reject) {
            self.resolve = resolve;
            self.reject = reject;
        });
    }

    BaseJob.prototype.isPending = function isPending() {
        return this._deferred.isPending();
    };

    /*
     * Add a cleanup() function if there are non-subscription
     * resources in the job that should be cleaned up on cancel().
     */
    BaseJob.prototype.cleanup = function() {
        var self = this;

        if (_.isFunction(self._cleanup)) {
            return Promise.resolve().then(function () {
                return self._cleanup();
            });
        } else {
            return Promise.resolve();
        }
    };

    BaseJob.prototype.runWrapper = function runWrapper() {
        var self = this;
        function before() {
            if (self.context.target) {
                return self._subscribeActiveTaskExists(function() {
                    return self.serialize();
                });
            } else {
                return Promise.resolve();
            }
        }

        return before().disposer(function() {
            return self.cleanup()
            .then(function() {
                // Handle resolution of created subscriptions in the case we cancel
                // while still initializing
                return Promise.all(self.subscriptionPromises);
            })
            .then(function() {
                return Promise.all(_.map(self.subscriptions, function(subscription) {
                    return subscription.dispose();
                }));
            });
        });
    };

    BaseJob.prototype.run = function run() {
        var self = this;

        return Promise.using(self.runWrapper(), function() {
            self.logger.debug("Running job.", {
                id: self.nodeId,
                module: self.logger.module,
                name: self.constructor.name,
                options: self.options,
                taskId: self.taskId,
                target: self.context.target || 'none'
            });

            self._run();
            return self._deferred;
        });
    };

    BaseJob.prototype.cancel = function cancel(error) {
        var loggerObject = {
            taskId: this.taskId,
            name: this.constructor.name
        };
        if (error) {
            loggerObject.error = error;
        }
        this.logger.info("Stopping job.", loggerObject);
        return this._done(error);
    };

    BaseJob.prototype._done = function _done(error) {
        if (this._deferred.isPending()) {
            if (error) {
                return Promise.resolve(this.reject(error));
            } else {
                return Promise.resolve(this.resolve());
            }
        }

        return Promise.resolve();
    };

    // enables JSON.stringify(this)
    BaseJob.prototype.toJSON = function toJSON() {
        return this.serialize();
    };

    BaseJob.prototype.serialize = function serialize() {
        var redactKeys = ['subscriptions' ,'subscriptionPromises', 'logger', '_deferred'];
        return _.transform(this, function(result, v, k) {
            if (!_.contains(redactKeys, k)) {
                result[k] = v;
            }
        }, {});
    };

    BaseJob.prototype._subscribeActiveTaskExists = function _subscribeActiveTaskExists(callback) {
        var self = this;
        assert.func(callback);
        assert.string(self.context.target);
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.activeTaskExists' + '.' + self.context.target,
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self, data.value);
                }).then(function (result) {
                    return message.resolve(
                        new Result({ value: result })
                    );
                }).catch(function (error) {
                    return message.reject(error);
                });
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeRequestProfile = function _subscribeRequestProfile(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.requestProfile' + '.' + self.nodeId,
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self);
                }).then(function (result) {
                    return message.resolve(
                        new Result({ value: result })
                    );
                }).catch(function (error) {
                    return message.reject(error);
                });
            }
        );
        
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeRequestProperties = function _subscribeRequestProperties(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.requestProperties' + '.' + self.nodeId,
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self);
                }).then(function (result) {
                    return message.resolve(
                        new Result({ value: result })
                    );
                }).catch(function (error) {
                    return message.reject(error);
                });
            }
        );
        
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeRespondCommands = function _subscribeRespondCommands(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);

        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.respondCommands' + '.' + self.nodeId,
            function(data) {
                callback.call(self, data.value);
            }
        );

        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeRequestCommands = function _subscribeRequestCommands(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);

        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.requestCommands' + '.' + self.nodeId,
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self);
                }).then(function (result) {
                    return message.resolve(
                        new Result({ value: result })
                    );
                }).catch(function (error) {
                    return message.reject(error);
                });
            }
        );

        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeHttpResponse = function _subscribeHttpResponse(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Events.Name,
            'http.response' + '.' + self.nodeId,
            callback.bind(self)
        );
        
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeGraphFinished = function _subscribeGraphFinished(callback) {
        var self = this;
        assert.func(callback);
        assert.uuid(self.graphId);
        var deferred = eventsProtocol.subscribeGraphFinished(self.graphId, callback.bind(self));
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._publishSnmpCommandResult =
        function _publishSnmpCommandResult(uuid, data) {

        if (data && data.community) {
            data.community = encryption.encrypt(data.community);
        }

        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            'snmp.command.result' + '.' + uuid,
            new Result({ value: results })
        );
    };

    BaseJob.prototype._subscribeSnmpCommandResult =
        function _subscribeSnmpCommandResult(uuid, callback) {

        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'snmp.command.result' + '.' + uuid,
            function(data) {
                self._runSnmpCommandCallback(callback.bind(self), data.value);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._runSnmpCommandCallback = function(callback, data) {
        var self = this;

        if (!data) {
            return;
        }
        if (data.community) {
            data.community = encryption.decrypt(data.community);
        }
        if (data.host && Constants.Regex.MacAddress.test(data.host)) {
            lookup.macAddressToIp(data.host)
            .catch(function(e) {
                self.logger.error("Failure looking up host IP for snmp poller", {
                    error: e
                });
            })
            .then(function(ipAddress) {
                if (!ipAddress) {
                    return;
                }
                data.host = ipAddress;
                callback.call(self, data);
            });
        } else {
            callback.call(self, data);
        }
    };

    BaseJob.prototype._subscribeRunSnmpCommand = function _subscribeRunSnmpCommand(uuid, callback) {
        var self = this;
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'run.snmp.command' + '.' + uuid,
            function(data) {
                if (data.value && data.value.community) {
                    data.value.community = encryption.decrypt(data.value.community);
                }
                callback.call(self, data.value);
            }
        );
        
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._publishRunSnmpCommand = function _publishRunSnmpCommand(uuid, hostData) {
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            'run.snmp.command' + '.' + uuid,
            new Result({ value: hostData })
        );
    };

    BaseJob.prototype._publishIpmiCommandResult =
        function _publishIpmiCommandResult(uuid, command, data) {

        if (data && data.password) {
            data.password = encryption.encrypt(data.password);
        }
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            ['ipmi', 'command', command, 'result', uuid].join('.'),
            new Result({ value: data })
        );
    };

    BaseJob.prototype._subscribeIpmiCommandResult =
        function _subscribeIpmiCommandResult(uuid, command, callback) {

        var self = this;
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            ['ipmi', 'command', command, 'result', uuid].join('.'),
            function(data) {
                if (data.value && data.value.password) {
                    data.value.password = encryption.decrypt(data.value.password);
                }
                callback.call(self, data.value);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._publishMetricResult =
        function _publishMetricResult(uuid, metricName, data) {

        if (data && data.community) {
            data.community = encryption.encrypt(data.community);
        }
        if (data && data.password) {
            data.password = encryption.encrypt(data.password);
        }
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            ['metric', metricName, 'result', uuid].join('.'),
            new Result({ value: data })
        );
    };

    BaseJob.prototype._subscribeMetricResult =
        function _subscribeMetricResult(uuid, metricName, callback) {

        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            ['metric', metricName, 'result', uuid].join('.'),
            function(data, envelope) {
                var metricName = envelope.deliveryInfo.routingKey.split('.')[1];
                if (data.value && data.value.community) {
                    data.value.community = encryption.encrypt(data.value.community);
                }
                if (data.value && data.value.password) {
                    data.value.password = encryption.encrypt(data.value.password);
                }
                callback.call(self, data.value, metricName);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeRunIpmiCommand =
        function _subscribeRunIpmiCommand(uuid, command, callback) {

        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            ['ipmi', 'command', command, uuid].join('.'),
            function(data) {
                self._runIpmiCommandCallback(callback.bind(self), data.value);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._runIpmiCommandCallback = function(callback, data) {
        var self = this;

        if (!data) {
            return;
        }
        if (data.password) {
            data.password = encryption.decrypt(data.password);
        }
        if (data.host && Constants.Regex.MacAddress.test(data.host)) {
            lookup.macAddressToIp(data.host)
            .catch(function(e) {
                self.logger.error("Failure looking up host IP for ipmi poller", {
                    error: e
                });
            })
            .then(function(ipAddress) {
                if (!ipAddress) {
                    return;
                }
                data.host = ipAddress;
                callback.call(self, data);
            });
        } else {
            callback.call(self, data);
        }
    };

    BaseJob.prototype._publishRunIpmiCommand =
        function _publishRunIpmiCommand(uuid, command, machine) {
        messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            ['ipmi', 'command', command, uuid].join('.'),
            new Result({ value: machine })
        );
    };

    BaseJob.prototype._publishPollerAlert = function _publishPollerAlert(id, pollerName, data) {
        messenger.publish(
            Constants.Protocol.Exchanges.Events.Name,
            ['poller.alert', pollerName, uuid].join('.'),
            new Result({ value: data })
        );
    };

    BaseJob.prototype._subscribeRequestPollerCache =
        function _subscribeRequestPollerCache(callback) {

        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.requestPollerCache',
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self, data.value, data.options);
                }).then(function (result) {
                    message.resolve(
                        new Result({ value: result })
                    );
                }).catch(function (error) {
                    message.reject(error);
                });
            }
        );
        
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeGetBootProfile = function _subscribeGetBootProfile(callback) {
        var self = this;
        assert.isMongoId(self.nodeId);
        assert.func(callback);
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'methods.getBootProfile' + '.' + self.nodeId,
            function(data, message) {
                Promise.resolve().then(function() {
                    return callback.call(self, data.value);
                }).then(function(result) {
                    return message.resolve(
                        new Result({ value: result })
                    );
                })
                .catch(function(error) {
                    return message.reject(error);
                });
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeAnsibleCommand =
        function _subscribeAnsibleCommand(uuid, callback) {
        var self = this;
        
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'run.ansible.command' + '.' + uuid,
            function(data) {
                self._ansibleCommandCallback(callback.bind(self), data.value)
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._ansibleCommandCallback = function(callback, data) {
        var self = this;
        if (!data) {
            return;
        }
        callback.call(self, data);
    };

    BaseJob.prototype._publishAnsibleResult =
        function _publishAnsibleResult(uuid, data) {
        
        messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            'run.ansible.command' + '.' + uuid,
            new Result({ value: data })
        );
    };

    BaseJob.prototype._publishTrigger = function _publishTrigger(id, type, group) {
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            'trigger' + '.' + id + '.' + group + '.' + type,
            {}
        );
    };

    BaseJob.prototype._subscribeTrigger = function _subscribeTrigger(id, type, group, callback) {
        var self = this;
        assert.func(callback);

        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'trigger' + '.' + id + '.' + group + '.' + type,
            function() {
                callback.call(self);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };

    BaseJob.prototype._subscribeFinishTrigger =
            function _subscribeFinishTrigger(id, group, callback) {
        var self = this;
        assert.func(callback);

        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'trigger' + '.' + id + '.' + group + '.' + 'finish',
            function() {
                callback.call(self);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };
    
    /**
     * @function _subscribeRedfishCommandResult
     * @description subscribe to amqp exchange to receive redfish command results
     */
    BaseJob.prototype._subscribeRedfishCommandResult = 
        function subscribeRedfishCommandResult(uuid, command, callback) {
        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            ['redfish', 'command', command, 'result', uuid].join('.'),
            function(data) {
                callback.call(self, data.value);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };
    
    /**
     * @function _publishRedfishCommandResult
     * @description publish the command result to an amqp exchange
     */
    BaseJob.prototype._publishRedfishCommandResult = 
        function _publishRedfishCommandResult (uuid, command, result) {
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            ['redfish', 'command', command, 'result', uuid].join('.'),
            new Result({ value: result })
        );
    };
    
    /**
     * @function _subscribeRedfishCommand
     * @description subscribe and wait for a request from the redfish command exchange
     */
    BaseJob.prototype._subscribeRedfishCommand = 
        function _subscribeRedfishCommand (uuid, callback) {
        var self = this;
        var deferred = messenger.subscribe(
            Constants.Protocol.Exchanges.Task.Name,
            'run.redfish.command' + '.' + uuid,
            function(data) {
                callback.call(self, data.value);
            }
        );
        self.subscriptionPromises.push(deferred);
        return deferred.then(function(subscription) {
            self.subscriptions.push(subscription);
        });
    };
    
    /**
     * @function _publishRunRedfishCommand
     * @description publish message on amqp to execute a redfish command
     */
    BaseJob.prototype._publishRunRedfishCommand = 
        function _publishRunRedfishCommand (uuid, hostData) {
        return messenger.publish(
            Constants.Protocol.Exchanges.Task.Name,
            'run.redfish.command' + '.' + uuid,
            new Result({ value: hostData })
        );
    };

    return BaseJob;
}
