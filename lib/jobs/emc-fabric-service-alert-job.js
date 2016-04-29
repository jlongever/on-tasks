// Copyright 2016, EMC, Inc.

'use strict';

var di = require('di');

module.exports = EmcFabricServicePollerAlertJobFactory;
di.annotate(EmcFabricServicePollerAlertJobFactory, new di.Provide(
    'Job.Poller.Alert.Emc.FabricService'
));
di.annotate(EmcFabricServicePollerAlertJobFactory, new di.Inject(
    'Job.Poller.Alert',
    'Logger',
    'Util',
    'Assert',
    'Promise',
    '_',
    'Services.Waterline'
));

function EmcFabricServicePollerAlertJobFactory(
    PollerAlertJob,
    Logger,
    util,
    assert,
    Promise,
    _,
    waterline
){
    var logger = Logger.initialize(EmcFabricServicePollerAlertJobFactory);

    /**
     *
     * @param {Object} options
     * @param {Object} context
     * @param {String} taskId
     * @constructor
     */
    function EmcFabricServicePollerAlertJob(options, context, taskId) {
        assert.object(context);
        assert.uuid(context.graphId);

        var subscriptionArgs = [context.graphId, 'fabricservice'];
        EmcFabricServicePollerAlertJob.super_.call(this, logger, options, context, taskId,
                '_subscribeRedfishCommandResult', subscriptionArgs);
    }
    util.inherits(EmcFabricServicePollerAlertJob, PollerAlertJob);

    EmcFabricServicePollerAlertJob.prototype._determineAlert = function _determineAlert(data) {
        return waterline.workitems.needByIdentifier(data.workItemId)
        .then(function (workitem) {
            var conf = workitem.config;
            data.pollerName = 'fabricservice'
            return data;
        })
        .then(function (alerts) {
            return _.isEmpty(alerts) ? undefined : alerts;
        })
        .catch(function (err) {
            logger.error(err.message, { error: err, data: data });
        });
    };

    return EmcFabricServicePollerAlertJob;
}
