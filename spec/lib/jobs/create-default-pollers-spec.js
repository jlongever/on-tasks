// Copyright 2015, EMC, Inc.
/* jshint node:true */

'use strict';

describe("Job.Pollers.CreateDefault", function () {
    var waterline = {};
    var CreateDefaultPollers;
    var pollers;
    var Promise;
    var uuid;
    var messenger;
    var testMessage;
    var testSubscription;
    
    before(function () {
        // create a child injector with on-core and the base pieces we need to test this
        helper.setupInjector([
            helper.require('/spec/mocks/logger.js'),
            helper.require('/lib/jobs/base-job.js'),
            helper.require('/lib/jobs/create-default-pollers.js'),
            helper.di.simpleWrapper(waterline, 'Services.Waterline')
        ]);

        CreateDefaultPollers = helper.injector.get('Job.Pollers.CreateDefault');
        Promise = helper.injector.get('Promise');
        uuid = helper.injector.get('uuid');
        
        messenger = helper.injector.get('Services.Messenger');
        var Message = helper.injector.get('Message');
        testMessage = new Message({},{},{routingKey:'test.route.key'});
        sinon.stub(testMessage);
                
        var Subscription = helper.injector.get('Subscription');
        testSubscription = new Subscription({},{});
        sinon.stub(testSubscription);
    });

    beforeEach(function () {
        waterline.workitems = {
            findOrCreate: sinon.stub().resolves()
        };
        waterline.nodes = {
            needByIdentifier: sinon.stub().resolves({
                obmSettings: [{
                    service: 'redfish-obm-service',
                    config: {}
                }]
            })
        };
        waterline.catalogs = {
            findMostRecent: sinon.stub().resolves({
                id: 'bc7dab7e8fb7d6abf8e7d6a1'
            })
        };
        pollers = [
            {
                "type": "ipmi",
                "pollInterval": 60000,
                "config": {
                    "command": "power"
                }
            }
        ];
        sinon.stub(messenger, 'subscribe', function(name,id,callback) {
            callback({value:'test'}, testMessage);
            return Promise.resolve(testSubscription);
        });
        sinon.stub(messenger, 'publish').resolves();
    });
    
    afterEach(function() {
        messenger.publish.restore();
        messenger.subscribe.restore();
    });
    
    it('should create pollers for a job with options.nodeId', function () {
        var nodeId = 'bc7dab7e8fb7d6abf8e7d6ad';

        var job = new CreateDefaultPollers(
            { nodeId: nodeId, pollers: pollers },
            { graphId: uuid.v4() },
            uuid.v4()
        );

        return job.run()
        .then(function() {
            expect(waterline.catalogs.findMostRecent).to.have.been.calledOnce;
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('node', nodeId);
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('source', 'bmc');
            expect(waterline.workitems.findOrCreate).to.have.been.calledOnce;
            expect(waterline.workitems.findOrCreate).to.have.been.calledWith(
                { node: nodeId, config: { command: pollers[0].config.command } }, pollers[0]);
        });
    });

    it('should create pollers for a job with context.target', function () {
        var nodeId = 'bc7dab7e8fb7d6abf8e7d6af';

        var job = new CreateDefaultPollers(
            { pollers: pollers },
            { target: nodeId, graphId: uuid.v4() },
            uuid.v4()
        );

        return job.run()
        .then(function() {
            expect(waterline.catalogs.findMostRecent).to.have.been.calledOnce;
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('node', nodeId);
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('source', 'bmc');
            expect(waterline.workitems.findOrCreate).to.have.been.calledOnce;
            expect(waterline.workitems.findOrCreate).to.have.been.calledWith(
                { node: nodeId, config: { command: pollers[0].config.command } }, pollers[0]);
        });
    });

    it('should not create pollers when bmc catalog does not exist', function () {
        var nodeId = 'bc7dab7e8fb7d6abf8e7d6af';

        waterline.catalogs.findMostRecent.resolves();

        var job = new CreateDefaultPollers(
            { pollers: pollers },
            { target: nodeId, graphId: uuid.v4() },
            uuid.v4()
        );

        return job.run()
        .then(function() {
            expect(waterline.catalogs.findMostRecent).to.have.been.calledOnce;
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('node', nodeId);
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('source', 'bmc');
            expect(waterline.workitems.findOrCreate).to.not.have.been.called;
        });
    });

    it('should create multiple pollers', function () {
        var nodeId = 'bc7dab7e8fb7d6abf8e7d6ad';

        pollers.push({
            "type": "snmp",
            "pollInterval": 60000,
            "config": {
                "metric": "snmp-interface-bandwidth-utilization"
            }
        });

        pollers.push({
            "type": "redfish",
            "pollInterval": 60000,
            "config": {
                "command": "thermal"
            }
        });

       pollers.push({
            "type": "redfish",
            "pollInterval": 60000,
            "config": {
                "command": "systems.logservice"
            }
        });

        var job = new CreateDefaultPollers(
            { nodeId: nodeId, pollers: pollers },
            { graphId: uuid.v4() },
            uuid.v4()
        );

        return job.run()
        .then(function() {
            expect(waterline.catalogs.findMostRecent).to.have.been.calledTwice;
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('node', nodeId);
            expect(waterline.catalogs.findMostRecent.firstCall.args[0])
                .to.have.property('source', 'bmc');
            expect(waterline.catalogs.findMostRecent.secondCall.args[0])
                .to.have.property('node', nodeId);
            expect(waterline.catalogs.findMostRecent.secondCall.args[0])
                .to.have.property('source', 'snmp-1');
            expect(waterline.workitems.findOrCreate).to.have.been.callCount(4);
            expect(waterline.workitems.findOrCreate).to.have.been.calledWith(
                { node: nodeId, config: { command: pollers[0].config.command } }, pollers[0]);
            expect(waterline.workitems.findOrCreate).to.have.been.calledWith(
                { node: nodeId, config: { command: pollers[1].config.command } }, pollers[1]);
        });
    });
    
    
    it('should fail on missing redfish service', function () {
        var nodeId = 'bc7dab7e8fb7d6abf8e7d6ad';
        pollers = [{
            "type": "redfish",
            "pollInterval": 60000,
            "config": {
                "command": "thermal"
            }
        }];
        
        waterline.nodes = {
            needByIdentifier: sinon.stub().resolves({
                obmSettings: []
            })
        };

        var job = new CreateDefaultPollers(
            { nodeId: nodeId, pollers: pollers },
            { graphId: uuid.v4() },
            uuid.v4()
        );

        return expect(job.run())
            .to.be.rejectedWith('Required redfish-obm-service settings are missing.');
    });
    
});




