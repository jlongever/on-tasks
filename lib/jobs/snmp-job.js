// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di');

module.exports = snmpJobFactory;
di.annotate(snmpJobFactory, new di.Provide('Job.Snmp'));
di.annotate(snmpJobFactory, new di.Inject(
    'Job.Base',
    'JobUtils.Snmptool',
    'Constants',
    'Logger',
    'Util',
    'Assert',
    'Promise',
    '_',
    'Services.Waterline',
    di.Injector,
    'JobUtils.PollerHelper'
));

function snmpJobFactory(
    BaseJob,
    SnmpTool,
    Constants,
    Logger,
    util,
    assert,
    Promise,
    _,
    waterline,
    injector,
    pollerHelper
) {
    var logger = Logger.initialize(snmpJobFactory);

    /**
     *
     * @param {Object} options
     * @param {Object} context
     * @param {String} taskId
     * @constructor
     */
    function SnmpJob(options, context, taskId) {
        SnmpJob.super_.call(this, logger, options, context, taskId);
        this.concurrent = {};
        this.resultCache = {};
        this.maxConcurrent = 1;
        this.routingKey = context.graphId;
        assert.uuid(this.routingKey, 'routing key uuid');
    }

    util.inherits(SnmpJob, BaseJob);

    SnmpJob.prototype.concurrentRequests = function(host, workItemId) {
        assert.string(host);
        assert.string(workItemId);
        if(!_.has(this.concurrent, host)){
            this.concurrent[host] = {};
        }
        if(!_.has(this.concurrent[host], workItemId)){
            this.concurrent[host][workItemId] = 0;
        }
        if(this.concurrent[host][workItemId] >= this.maxConcurrent){
            return true;
        } else {
            return false;
        }
    };

    SnmpJob.prototype.addConcurrentRequest = function(host, workItemId) {
        assert.number(this.concurrent[host][workItemId]);
        this.concurrent[host][workItemId] += 1;
    };

    SnmpJob.prototype.removeConcurrentRequest = function(host, workItemId) {
        assert.number(this.concurrent[host][workItemId]);
        this.concurrent[host][workItemId] -= 1;
    };


    /**
     * @memberOf SnmpJob
     */
    SnmpJob.prototype._run = function() {
        // NOTE: this job will run indefinitely absent user intervention
        var self = this;

        return waterline.workitems.update({name: "Pollers.SNMP"}, {failureCount: 0})
        .then(function() {
            self._subscribeRunSnmpCommand(self.routingKey, function(data) {
                if (self.concurrentRequests(data.host, data.workItemId)) {
                    return;
                }
                self.addConcurrentRequest(data.host, data.workItemId);
                assert.object(data.config, 'SNMP poller data config');

                return Promise.resolve()
                .then(function() {
                    if (data.config.metric) {
                        return self._collectMetricData(data)
                        .then(function(result) {
                            data.result = result;
                            return self._publishMetricResult(self.routingKey,
                                    data.config.metric, data);
                        });
                    } else if (data.config.oids){
                        var snmptool = new SnmpTool(data.host, data.community);
                        var options = { numericOutput: true };
                        return snmptool.collectHostSnmp(data.config.oids, options)
                        .then(function(result) {
                            data.result = result;
                            return self._publishSnmpCommandResult(self.routingKey, data);
                        });
                    } else {
                        throw new Error("Unknown poller implementation." +
                                   " No recognized config keys");
                    }
                })
                .then(function() {
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
                    logger.warning("Failed to capture data through SNMP.", {
                        data: data,
                        error: err
                    });
                    return waterline.workitems.findOne({ id: data.workItemId})
                    .then(function(workitem) {
                        return pollerHelper.getNodeAlertMsg(workitem.node, workitem.state,
                            "inaccessible")
                            .tap(function(message){
                                return waterline.workitems.setFailed(null, message, workitem);
                            });
                    });
                })
                .finally(function() {
                    self.removeConcurrentRequest(data.host, data.workItemId);
                });
            });
        })
        .catch(function(err) {
            logger.error("Failed to initialize job", { error:err });
            self._done(err);
        });
    };
    
    /**
     * @memberOf SnmpJob
     */
    SnmpJob.prototype._collectMetricData = function(data) {
        var self = this;
        assert.object(data);
        assert.object(data.config);
        assert.string(data.config.metric);
        var Metric, metric;
        if(!_.has(self.resultCache, data.workItemId)) {
            self.resultCache[data.workItemId] = {};
            self.resultCache[data.workItemId][data.config.metric] = {};
        }
        switch (data.config.metric) {
            case Constants.WorkItems.Pollers.Metrics.SnmpInterfaceBandwidthUtilization:
                Metric = injector.get('JobUtils.Metrics.Snmp.InterfaceBandwidthUtilizationMetric');
                metric = new Metric(data.node, data.host, data.community, data.pollInterval);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpInterfaceState:
                Metric = injector.get('JobUtils.Metrics.Snmp.InterfaceStateMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpProcessorLoad:
                Metric = injector.get('JobUtils.Metrics.Snmp.ProcessorLoadMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpMemoryUsage:
                Metric = injector.get('JobUtils.Metrics.Snmp.MemoryUsageMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpPduPowerStatus:
                Metric = injector.get('JobUtils.Metrics.Snmp.PduPowerMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpPduSensorStatus:
                Metric = injector.get('JobUtils.Metrics.Snmp.PduSensorMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            case Constants.WorkItems.Pollers.Metrics.SnmpTxRxCounters:
                Metric = injector.get('JobUtils.Metrics.Snmp.TxRxCountersMetric');
                metric = new Metric(data.node, data.host, data.community);
                break;
            default:
                throw new Error("Unknown poller metric name: " + data.config.metric);
        }
        
        var dataCopy = _.cloneDeep(data);
        dataCopy.cache = self.resultCache;
        dataCopy.routingKey = self.routingKey;
        return metric.collectMetricData(dataCopy)
        .then(function(results) {
            self.resultCache[data.workItemId][data.config.metric] = _.cloneDeep(results);
            return results; 
        });
    };
    return SnmpJob;
}
