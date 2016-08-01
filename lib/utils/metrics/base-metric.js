// Copyright 2015, EMC, Inc.

'use strict';

var di = require('di');

module.exports = baseMetricFactory;
di.annotate(baseMetricFactory, new di.Provide('JobUtils.Metrics.Snmp.Base'));
di.annotate(baseMetricFactory, new di.Inject(
    'JobUtils.Snmptool',
    'Services.Waterline',
    'Assert',
    'Promise',
    '_',
    'Services.Environment',
    'Constants'
));
function baseMetricFactory(
    SnmpTool,
    waterline,
    assert,
    Promise,
    _,
    env,
    Constants
) {

    var sharedOidDescriptionMap = {};

    var oidDescriptionQueryMap = {
        names: 'IF-MIB::ifName',
        processors: 'HOST-RESOURCES-MIB::hrDeviceDescr',
        storage: 'HOST-RESOURCES-MIB::hrStorageDescr'
    };

    function BaseMetric(nodeId, host, community) {
        assert.string(nodeId, 'SNMP metric nodeId');
        assert.string(host, 'SNMP metric host');
        assert.string(community, 'SNMP metric community');
        this.nodeId = nodeId;
        this.snmptool = new SnmpTool(host, community);
        this.oidDescriptionMap = sharedOidDescriptionMap;
    }

    BaseMetric.prototype.identify = function() {
        var self = this;

        return this.getNodeType()
        .then(function(nodeType) {
            self.nodeType = nodeType;
        });
    };

    BaseMetric.prototype.updateOidDescriptionMapByType = function(cacheType) {
        var self = this;

        if (!oidDescriptionQueryMap[cacheType]) {
            return Promise.reject(new Error('Unknown OID description map type: ' + cacheType));
        }

        // We want to update the cache for 'names' every time, because interfaces
        // can change or be created if, for example, a new VLAN is added or something is renamed.
        // For everything else, like RAM and Processors, we can assume they will
        // not change, and collecting it just once is enough.
        if (cacheType !== 'names' && !_.isEmpty(self.oidDescriptionMap[self.nodeId], cacheType)) {
            return Promise.resolve(_.keys(self.oidDescriptionMap[self.nodeId]).length);
        }

        return self.snmptool.collectHostSnmp([oidDescriptionQueryMap[cacheType]])
        .then(function(result) {
            _.forEach(result[0].values, function(descr, oid) {
                var elementOid = _.last(oid.split('.'));
                if (!self.oidDescriptionMap[self.nodeId]) {
                    self.initializeDescriptionMapForNode();
                }
                self.oidDescriptionMap[self.nodeId][cacheType][elementOid] = descr;
            });

            return _.keys(result[0].values).length;
        });
    };

    BaseMetric.prototype.initializeDescriptionMapForNode = function() {
        var self = this;
        self.oidDescriptionMap[self.nodeId] = {};
        _.forEach(_.keys(oidDescriptionQueryMap), function(key) {
            self.oidDescriptionMap[self.nodeId][key] = {};
        });
    };

    BaseMetric.prototype.getNodeType = function() {
        var self = this;
        return waterline.nodes.needByIdentifier(self.nodeId)
        .then(function(node) {
            if(node.sku) {
                return env.get('config.type', 'unknown', [node.sku, Constants.Scope.Global]);
            }
            return waterline.catalogs.findMostRecent({"node": self.nodeId, "source": "snmp-1"})
            .then(function(catalog) {
                if (catalog) {
                    var sysDescr = catalog.data['SNMPv2-MIB::sysDescr_0'];
                    if (_.contains(sysDescr, 'Arista')) {
                        return 'arista';
                    } else if (_.contains(sysDescr, 'Cisco')) {
                        return 'cisco';
                    } else if (_.contains(sysDescr, 'Sinetica')) {
                        return 'sinetica';
                    } else {
                        return 'unknown';
                    }
                } else {
                    return 'unknown';
                }
            });
        })
    };

    return BaseMetric;
}
