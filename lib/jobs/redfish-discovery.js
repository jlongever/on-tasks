// Copyright 2016, EMC, Inc.

'use strict';

var di = require('di');
var redfish = require('redfish-node');

module.exports = RedfishDiscoveryJobFactory;
di.annotate(RedfishDiscoveryJobFactory, new di.Provide('Job.Redfish.Discovery'));
    di.annotate(RedfishDiscoveryJobFactory,
    new di.Inject(
        'Job.Base',
        'Logger',
        'Promise',
        'Assert',
        'Util',
        'Services.Waterline',
        'Services.Encryption',
        '_'
    )
);
function RedfishDiscoveryJobFactory(
    BaseJob,
    Logger,
    Promise,
    assert,
    util,
    waterline,
    encryption,
    _
) {
    var logger = Logger.initialize(RedfishDiscoveryJobFactory);

    /**
     * @param {Object} options task options object
     * @param {Object} context graph context object
     * @param {String} taskId running task identifier
     * @constructor
     */
    function RedfishDiscoveryJob(options, context, taskId) {
        RedfishDiscoveryJob.super_.call(this,
                                   logger,
                                   options,
                                   context,
                                   taskId);

        assert.ok(this.options);
        assert.string(this.options.uri);
        
        this.uri = this.options.uri;
        this.username = this.options.username;
        this.password = this.options.password;
        this.redfishApi = undefined;
    }
    util.inherits(RedfishDiscoveryJob, BaseJob);

    /**
     * @memberOf RedfishDiscoveryJob
     */
    RedfishDiscoveryJob.prototype._run = function() {
        var self = this,
            apiClient = new redfish.ApiClient();
        apiClient.basePath = self.uri.replace(/\/+$/, '');
        
        // setup basic authorization
        if (self.username !== undefined && 
            self.password !== undefined) {
            var token = new Buffer(self.username + ':' + self.password).toString('base64');
            apiClient.defaultHeaders['Authorization'] = 'Basic ' + token;
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // (jl) need a ssl_verify option here.
        }
        
        self.redfishApi = Promise.promisifyAll(new redfish.RedfishvApi(apiClient));
        return self.runChassisCatalog()
        .then(function() {
            self._done();
        })
        .catch(function(err) {
            self._done(err);
        });
    };
    
    /**
     * @function runChassisCatalog
     * @description initiate redfish chassis discovery 
     */
    RedfishDiscoveryJob.prototype.runChassisCatalog = function () {
        var self = this;
        var settings = {
            uri: self.uri,
            username: self.username,
            password: self.password
        };
        
        return self.redfishApi.listChassisAsync()
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(member) {
            var chassisId = member['@odata.id'].split('Chassis/')[1];
            return self.redfishApi.getChassisAsync(chassisId);
        })
        .map(function(chassis) {
            assert.object(chassis);
            var catalog = {};
            var data = chassis[1].body;
            catalog['source'] = 'Chassis';
            catalog['data'] = data;
            return waterline.nodes.create({
                type: 'enclosure',
                name: data.Name,
                catalogs: catalog
            });
        })
        .map(function(enclosure) {
            self.getRelatedItems(enclosure.id, 'Chassis')
            .then(function(ids) {
                assert.ok(Array.isArray(ids), 
                    'expected array of chassis identifiers');
                var updateData = {
                    relations: [{
                        relationType: 'encloses',
                        targets: ids
                    }]
                };
                return waterline.nodes.updateByIdentifier(
                    enclosure.id,
                    updateData
                );
            });
            return enclosure;
        })
        .map(function(enclosure) {
            assert.object(enclosure);
            return waterline.catalogs.findLatestCatalogOfSource(
                enclosure.id, 
                'Chassis'
            );
        })
        .map(function(catalog) {
            assert.object(catalog);
            return self.runSystemsCatalog(
                catalog.data.Links.ComputerSystems
            );
        });
    };

    /**
     * @param {String} sysRef a Redfish system members object
     * @function runSystemsCatalog
     * @description initiate redfish compliant computer system inventory 
     */
    RedfishDiscoveryJob.prototype.runSystemsCatalog = function (sysRef) {
        assert.object(sysRef);
        
        var self = this;
        if (!(sysRef instanceof Array)) {
            sysRef = [ sysRef ];
        }
        
        return Promise.map(sysRef, function(sys) {
            return self.redfishApi.getSystemAsync(
                sys['@odata_id'].split('Systems/')[1]
            );
        })
        .map(function(system) {
            assert.object(system);
            var catalog = {};
            var data = system[1].body;
            catalog['source'] = 'ComputerSystem';
            catalog['data'] = data;
            return waterline.nodes.create({
                type: 'compute',
                name: data.Name,
                catalogs: catalog
            });
        })
        .map(function(compute) {
            self.getRelatedItems(compute.id, 'ComputerSystem')
            .then(function(ids) {
                assert.ok(Array.isArray(ids), 
                    'expected array of compute identifiers');
                var updateData = {
                    relations : [{
                        relationType: 'enclosedBy',
                        targets: ids
                    }]
                };
                return waterline.nodes.updateByIdentifier(
                    compute.id,
                    updateData
                );
            });
            return compute;
        })
        .map(function(compute) {
            assert.object(compute);
            return waterline.catalogs.findLatestCatalogOfSource(
                compute.id, 
                'ComputerSystem'
            );
        })
        .map(function(catalog) {
            assert.object(catalog);
            return Promise.all([
                self.runProcessorCatalog(
                    catalog.node,
                    catalog.data.Id
                ),
                self.runSimpleStorageCatalog(
                    catalog.node,
                    catalog.data.Id
                ),
                self.runLogServicesCatalog(
                    catalog.node,
                    catalog.data.Id
                ),
                self.runBootImageCatalog(
                    catalog.node,
                    catalog.data.Id
                ),
                self.runResetActionCatalog(
                    catalog.node,
                    catalog.data.Id
                )
            ]);
        });
    };

    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} sysId the redfish system node identifier
     * @function runProcessorCatalog
     * @description inventory the systems processor data
     */
    RedfishDiscoveryJob.prototype.runProcessorCatalog = function (nodeId, sysId) {
        var self = this;
        
        return self.redfishApi.listSystemProcessorsAsync(sysId)
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(members) {
            assert.object(members);
            var socketId = members['@odata.id'].split('Processors/')[1];
            return self.redfishApi.getSystemProcessorAsync(
                sysId,
                socketId
            );
        })
        .map(function(processors) {
            assert.object(processors);
            return processors[1].body;
        })
        .then(function(procData) {
            assert.object(procData);
            return waterline.catalogs.create({
                node: nodeId,
                data: procData,
                source: 'Processors'
            });        
        });
    };
    
    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} sysId the redfish system node identifier
     * @function runSimpleStorageCatalog
     * @description inventory the systems simple storage data
     */
    RedfishDiscoveryJob.prototype.runSimpleStorageCatalog = function (nodeId, sysId) {
        var self = this;
        
        return self.redfishApi.listSimpleStorageAsync(sysId)
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(members) {
            assert.object(members);
            var storageDev = members['@odata.id'].split('SimpleStorage/')[1];
            return self.redfishApi.getSimpleStorageAsync(
                sysId,
                storageDev
            );
        })
        .map(function(device) {
            assert.object(device);
            var storageData = device[1].body;
            return waterline.catalogs.create({
                node: nodeId,
                data: storageData,
                source: 'SimpleStorage'
            });
        });
    };
    
    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} sysId the redfish system node identifier
     * @function runLogServicesCatalog
     * @description inventory the systems log services data
     */
    RedfishDiscoveryJob.prototype.runLogServicesCatalog = function (nodeId, sysId) {
        var self = this;
        
        return self.redfishApi.listLogServiceAsync(sysId)
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(members) {
            assert.object(members);
            return self.redfishApi.getSelLogServiceAsync(sysId);
        })
        .map(function(device) {
            assert.object(device);
            var logServiceData = device[1].body;
            return waterline.catalogs.create({
                node: nodeId,
                data: logServiceData,
                source: 'LogServices'
            });
        });
    };

    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} sysId the redfish system node identifier
     * @function runBootImageCatalog
     * @description inventory the systems boot image data
     */
    RedfishDiscoveryJob.prototype.runBootImageCatalog = function (nodeId, sysId) {
        var self = this;
        
        return self.redfishApi.listBootImageAsync(sysId)
        .then(function(res) {
            assert.object(res);
            var bootImages = res[1].body;
            return waterline.catalogs.create({
                node: nodeId,
                data: bootImages,
                source: 'BootImage'
            });
        });
    };
    
    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} sysId the redfish system node identifier
     * @function runResetActionCatalog
     * @description inventory the systems reset action data
     */
    RedfishDiscoveryJob.prototype.runResetActionCatalog = function (nodeId, sysId) {
        var self = this;
        
        return self.redfishApi.listResetTypesAsync(sysId)
        .then(function(res) {
            assert.object(res);
            var resetActions = res[1].body;
            return waterline.catalogs.create({
                node: nodeId,
                data: resetActions,
                source: 'ResetAction'
            });
        });
    };
    
    /**
     * @param {String} nodeId our mongo node identifier to be updated
     * @param {String} memberType the redfish member type (Chassis, ComputerSystem)
     * @function getRelatedItems
     * @description return list of identifiers related to this node
     */
    RedfishDiscoveryJob.prototype.getRelatedItems = function( nodeId, memberType ) {
        var self = this;
        return waterline.catalogs.findLatestCatalogOfSource(nodeId, memberType)
        .then(function(catalog) {
            assert.object(catalog);
            if (_.has(catalog, 'data.Links.Chassis')) {
                return catalog.data.Links.Chassis;
            }
            if (_.has(catalog, 'data.Links.ComputerSystems')) {
                return catalog.data.Links.ComputerSystems;
            }
        })
        .then(function(members) {
            assert.ok(Array.isArray(members), 
                'expected an array of ' + memberType + ' members');
            return _.without(_.flattenDeep(members), undefined);
        })
        .map(function(dataId) {
            var path = (memberType === 'ComputerSystem') ? 'Chassis/' : 'Systems/',
                id = dataId['@odata_id'].split(path)[1];
            assert.string(id);
            return id;
        })
        .then(function(ids) {
            return Promise.resolve(ids);
        })
        .catch(function(err) {
            return Promise.reject(err);
        });
    };
    
    return RedfishDiscoveryJob;
}
