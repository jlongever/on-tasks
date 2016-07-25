// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di');

module.exports = ipmiJobFactory;
di.annotate(ipmiJobFactory, new di.Provide('Job.Ipmi'));
di.annotate(ipmiJobFactory, new di.Inject(
    'Job.Base',
    'JobUtils.Ipmitool',
    'JobUtils.IpmiCommandParser',
    'Logger',
    'Util',
    'Assert',
    'Promise',
    '_',
    'Services.Waterline',
    'JobUtils.PollerHelper'
));

function ipmiJobFactory(
    BaseJob,
    ipmitool,
    parser,
    Logger,
    util,
    assert,
    Promise,
    _,
    waterline,
    pollerHelper
) {
    var logger = Logger.initialize(ipmiJobFactory);

    /**
     *
     * @param {Object} options
     * @param {Object} context
     * @param {String} taskId
     * @constructor
     */
    function IpmiJob(options, context, taskId) {
        IpmiJob.super_.call(this, logger, options, context, taskId);

        this.routingKey = this.context.graphId;
        assert.uuid(this.routingKey, 'routing key uuid') ;

        this.concurrent = {};
        this.cachedPowerState = {};
    }
    util.inherits(IpmiJob, BaseJob);

    /**
     * @memberOf IpmiJob
     */
    IpmiJob.prototype._run = function run() {
        // NOTE: this job will run indefinitely absent user intervention
        var self = this;
           return waterline.workitems.update({name: "Pollers.IPMI"}, {failureCount: 0})
        .then(function() {
            self._subscribeRunIpmiCommand(self.routingKey, 'selInformation',
                     self.createCallback('selInformation', self.collectIpmiSelInformation.bind(self)));
            self._subscribeRunIpmiCommand(self.routingKey, 'sel',
                    self.createCallback('sel', self.collectIpmiSel.bind(self)));
            self._subscribeRunIpmiCommand(self.routingKey, 'sdr',
                    self.createCallback('sdr', self.collectIpmiSdr.bind(self)));
            self._subscribeRunIpmiCommand(self.routingKey, 'chassis',
                    self.createCallback('chassis', self.collectIpmiChassis.bind(self)));
            self._subscribeRunIpmiCommand(self.routingKey, 'driveHealth',
                     self.createCallback('driveHealth', self.collectIpmiDriveHealth.bind(self)));
        })
        .catch(function(err) {
            logger.error("Failed to initialize job", { error:err });
            self._done(err);
        });
        // BaseJob._subscribeRunIpmiCommand will bind these callbacks to this
    };

    // Only allow one request per IPMI command type per node
    /**
     * @memberOf IpmiJob
     */
    IpmiJob.prototype.concurrentRequests = function(host, type) {
        assert.string(host);
        assert.string(type);

        if (!_.has(this.concurrent, host)) {
            this.concurrent[host] = {
                sdr: 0,
                selInformation: 0,
                sel: 0,
                chassis: 0,
                driveHealth: 0
            };
        }
        if (this.concurrent[host][type] > 0) {
            return true;
        } else {
            return false;
        }
    };

    /**
     * @memberOf IpmiJob
     */
    IpmiJob.prototype.addConcurrentRequest = function(host, type) {
        assert.object(this.concurrent[host]);
        assert.number(this.concurrent[host][type]);
        this.concurrent[host][type] += 1;
    };

    /**
     * @memberOf IpmiJob
     */
    IpmiJob.prototype.removeConcurrentRequest = function(host, type) {
        assert.object(this.concurrent[host]);
        assert.number(this.concurrent[host][type]);
        this.concurrent[host][type] -= 1;
    };

    IpmiJob.prototype.createCallback = function(cmd, ipmiCallBack) {
        var self = this;
        function genericCallback(data) {
            if (!data.host || !data.user || !data.password) {
                return;
            }
            if (self.concurrentRequests(data.host, cmd)) {
                return;
            }
            self.addConcurrentRequest(data.host, cmd);
            return ipmiCallBack(data)
            .then(function(result) {
                data[cmd] = result;
                if(data.password) {
                    delete data.password;
                }
                return self._publishIpmiCommandResult(self.routingKey, cmd, data);
            }).then(function() {
                return waterline.workitems.findOne({ id: data.workItemId });
            })
            .then(function(workitem) {
                return pollerHelper.getNodeAlertMsg(workitem.node, workitem.state,
                    "accessible")
                .tap(function(message){
                    return waterline.workitems.setSucceeded(null, message, workitem);
                });
            })
            .catch(function (err) {
                if(data.password) {
                    delete data.password;
                }
                logger.error("Failed to capture IPMI " + cmd +" status data.", {
                    data: data,
                    error: err
                });
                return waterline.workitems.findOne({ id: data.workItemId })
                .then(function(workitem) {
                    return pollerHelper.getNodeAlertMsg(workitem.node, workitem.state,
                        "inaccessible")
                    .tap(function(message){
                        return waterline.workitems.setFailed(null, message, workitem);
                    });
                });
            })
            .finally(function() {
                self.removeConcurrentRequest(data.host, cmd);
            });
        }
        return genericCallback;
    };

    /**
     * Collect SEL information from IPMI
     * @memberOf IpmiJob
     *
     * @param data
     */
    IpmiJob.prototype.collectIpmiSelInformation = function(data) {
        return ipmitool.selInformation(data.host, data.user, data.password)
        .then(function (sel) {
            return parser.parseSelInformationData(sel);
        });
    };

    /**
     * Collect SEL entries list from IPMI
     * @memberOf IpmiJob
     *
     * @param data
     * @param count
     */
    IpmiJob.prototype.collectIpmiSel = function(data, count) {
        count = count || 25;
        return ipmitool.sel(data.host, data.user, data.password, count)
        .then(function (sel) {
            return parser.parseSelData(sel);
        });
    };

    /**
     * Collect SDR data from IPMI, promise chaining to extract values (parse the SDR)
     * and "store" the samples
     * @memberOf IpmiJob
     *
     * @param machine
     */
    IpmiJob.prototype.collectIpmiSdr = function(machine) {
        var host = machine.host,
            user = machine.user,
            password = machine.password;

        return ipmitool.sensorDataRepository(host, user, password)
        .then(function (sdr) {
            return parser.parseSdrData(sdr);
        });
    };
    
    /**
     * Compare current and last power states and publish alert on a state change
     * @memberOf IpmiJob
     * @param status
     * @param data
     */    
     IpmiJob.prototype.powerStateAlerter = Promise.method(function(status, data) {
        var self = this;        
        if(self.cachedPowerState[data.workItemId] !== status.power) {
            self._publishPollerAlert(self.routingKey, 'chassis.power', {
                states: {
                    last: self.cachedPowerState[data.workItemId] ? 'ON' : 'OFF',
                    current: status.power ? 'ON' : 'OFF'
                },
                nodeRef: '/nodes/' + data.node,
                dataRef: '/pollers/' + data.workItemId + '/data/current'
            });
            self.cachedPowerState[data.workItemId] = status.power;
        }
        return status;
    });

    /**
     * Collect chassis status data from IPMI
     * @memberOf IpmiJob
     *
     * @param data
     */
    IpmiJob.prototype.collectIpmiChassis = function(data) {
        var self = this;
        return ipmitool.chassisStatus(data.host, data.user, data.password)
        .then(function(status) {
            return [ parser.parseChassisData(status), data ];
        })
        .spread(self.powerStateAlerter.bind(self))
        .then(function(status) {
            return status;
        });
    };

    /**
     * Collect drive health status data from IPMI
     * @memberOf IpmiJob
     *
     * @param data
     */
    IpmiJob.prototype.collectIpmiDriveHealth = function(data) {
        return ipmitool.driveHealthStatus(data.host, data.user, data.password)
        .then(function (status) {
            return parser.parseDriveHealthData(status);
        });
    };

    return IpmiJob;
}
