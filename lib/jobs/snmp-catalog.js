// Copyright 2015, EMC, Inc.

'use strict';

module.exports = snmpCatalogJobFactory;

var di = require('di');
di.annotate(snmpCatalogJobFactory, new di.Provide('Job.Snmp.Catalog'));
di.annotate(snmpCatalogJobFactory, new di.Inject(
            'Job.Base',
            'Logger',
            'Util',
            'Services.Waterline',
            '_',
            'Assert',
            'Promise'
        )
);


function snmpCatalogJobFactory(BaseJob, Logger, util, waterline, _, assert, Promise) {
    var logger = Logger.initialize(snmpCatalogJobFactory);

    function SnmpCatalogJob(options, context, taskId) {
        SnmpCatalogJob.super_.call(this, logger, options, context, taskId);
        this.routingKey = context.graphId;
        this.nodeId = this.context.target;
        assert.uuid(this.routingKey);
    }
    util.inherits(SnmpCatalogJob, BaseJob);
    
    SnmpCatalogJob.prototype.sanitize = Promise.method(function(data) {
        _.forEach(_.keys(data.values), function(key) {
            var newKey = key.replace(/['":-]|\./g,'_');
            data.values[newKey] = data.values[key];
            delete data.values[key];
        });
        return data;
    });

    SnmpCatalogJob.prototype._run = function _run() {
        var self = this;

        self._subscribeSnmpCommandResult(self.routingKey, function(data) {
            Promise.map(data.result, function(snmpData) {
                return self.sanitize(snmpData);
            })
            .map(function(snmpData) {
                return waterline.catalogs.create({
                    node: self.nodeId,
                    source: 'snmp_' + snmpData.source,
                    data: snmpData.values
                });
            })
            .spread(function() {
                self._done();
            })
            .catch(function(err) {
                self._done(err);
            });
        });
    };
    return SnmpCatalogJob;
}
