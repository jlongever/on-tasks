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

        assert.object(this.options);
        assert.string(this.options.uri);
        this.settings = {
            uri: this.options.uri,
            username: this.options.username,
            password: this.options.password
        };
        
        var apiClient = new redfish.ApiClient();
        apiClient.basePath = this.settings.uri.replace(/\/+$/, '');
        
        // setup basic authorization
        if (!_.isUndefined(this.settings.username) && 
            !_.isUndefined(this.settings.password)) {
            var token = new Buffer(
                this.settings.username + ':' + this.settings.password
            ).toString('base64');
            apiClient.defaultHeaders.Authorization = 'Basic ' + token;
            process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // (jl) need a ssl_verify option here.
        }
        this.redfishApi = Promise.promisifyAll(new redfish.RedfishvApi(apiClient));
    }
    util.inherits(RedfishDiscoveryJob, BaseJob);

    /**
     * @memberOf RedfishDiscoveryJob
     */
    RedfishDiscoveryJob.prototype._run = function() {
        var self = this;
        return Promise.resolve()
        .then(function() {
            return self.createRoot()
        })
        .then(function(root) {
            return self.createChassis(root);
        })
        .then(function(root) {
            return self.createSystems(root);
        })
        .then(function() {
            self._done();
        })
        .catch(function(err) {
            self._done(err);
        });
    };
    
    /**
     * @function createRoot
     * @description Create the redfish service root node
     */
    RedfishDiscoveryJob.prototype.createRoot = function () {
        var self = this;
        return self.redfishApi.getServiceRootAsync()
        .then(function(res) {
            assert.ok(Array.isArray(res));
            return res[1].body;
        })
        .then(function(data) {
            return waterline.nodes.findOrCreate({
                type: 'redfish',
                name: data.Name,
                obmSettings: [{
                    config: self.settings,
                    service: 'redfish-obm-service'
                }]
            });
        });
    };
    
    /**
     * @function createChassis
     * @description initiate redfish chassis discovery
     */
    RedfishDiscoveryJob.prototype.createChassis = function (root) {
        assert.object(root, 'Root Node Object');
    
        var self = this;
        return self.redfishApi.listChassisAsync()
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(member) {
            var id = member['@odata.id']
                .split('Chassis/')[1].split(/\/+$/)[0]; // trim slash
                
            assert.string(id);
            return self.redfishApi.getChassisAsync(id)
            .catch(function(err) {
                throw new Error(err.response.text);
            });
        })
        .map(function(chassis) {
            chassis = chassis[1].body;
            var systems = _.get(chassis, 'Links.ComputerSystems') ||
                          _.get(chassis, 'links.ComputerSystems');
            
            if (_.isUndefined(systems)) {
                return Promise.reject(
                    new Error('failed to find System members for Chassis')
                );
            }
                          
            return systems;
        })
        .map(function(data) {
            assert.object(data);
            var targetList = [];
            
            _.forEach(data, function(sys) {
                var target = _.get(sys, '@odata.id') ||
                             _.get(sys, 'href');
                targetList.push(target);
            });
            
            return waterline.nodes.needByIdentifier(root.id)
            .then(function(node) {
                if (node.relations) {
                    node.relations.push({
                        name: 'chassis',
                        relationType: 'encloses',
                        targets: targetList
                    });
                }
                return node.relations;
            })
            .then(function(relations) {
                return waterline.nodes.updateByIdentifier(root.id, 
                    { relations: relations });
            })
        })
        .then(function() {
            return root;
        });
    };
    
    /**
     * @function createSystems
     * @description initiate redfish system discovery
     */
    RedfishDiscoveryJob.prototype.createSystems = function (root) {
        assert.object(root, 'Root Node Object');
        
        var self = this;   
        return self.redfishApi.listSystemsAsync()
        .then(function(res) {
            assert.object(res);
            return res[1].body.Members;
        })
        .map(function(member) {
            var id = member['@odata.id']
                .split('Systems/')[1].split(/\/+$/)[0]; // trim slash
            assert.string(id);
            return self.redfishApi.getSystemAsync(id)
            .catch(function(err) {
                throw new Error(err.response.text);
            });
        })
        .map(function(system) {
            system = system[1].body;
            var chassis = _.get(system, 'Links.Chassis') || 
                          _.get(system, 'links.Chassis');
            
            if (_.isUndefined(chassis)) {
                return Promise.reject(
                    new Error('failed to find Chassis members for Systems')
                );
            }
            return chassis;
        })
        .map(function(data) {
            assert.object(data);
            var targetList = [];
            
            _.forEach(data, function(chassis) { 
                var target = _.get(chassis, '@odata.id') ||
                             _.get(chassis, 'href');
                targetList.push(target);
            });
                        
            return waterline.nodes.needByIdentifier(root.id)
            .then(function(node) {
                if (node.relations) {
                    node.relations.push({
                        name: 'systems',
                        relationType: 'enclosedBy',
                        targets: targetList
                    });
                }
                return node.relations;
            })
            .then(function(relations) {
                return waterline.nodes.updateByIdentifier(root.id, 
                    { relations: relations });
            })
        })
        .then(function() {
            return root;
        });
    };
    
    return RedfishDiscoveryJob;
}
