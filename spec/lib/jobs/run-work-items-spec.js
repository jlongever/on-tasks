// Copyright 2015, EMC, Inc.
/* jshint node:true */

'use strict';

describe("Job.Catalog.RunWorkItem", function () {
    var waterline = {};
    var RunWorkItems;
    var uuid;
    var messenger;
    var testMessage;
    var testSubscription;
    
    before(function () {
        // create a child injector with on-core and the base pieces we need to test this
        helper.setupInjector([
            helper.require('/spec/mocks/logger.js'),
            helper.require('/lib/jobs/base-job.js'),
            helper.require('/lib/jobs/run-work-items.js'),
            helper.di.simpleWrapper(waterline, 'Services.Waterline')
        ]);

        RunWorkItems = helper.injector.get('Job.WorkItems.Run');
        uuid = helper.injector.get('uuid');

        waterline.workitems = {
            startNextScheduled: sinon.stub().resolves(),
            setSucceeded: sinon.stub(),
            setFailed: sinon.stub(),
            update: sinon.stub()
        };
        waterline.nodes = {
            findOne: sinon.stub()
        };
        
        messenger = helper.injector.get('Services.Messenger');
        var Message = helper.injector.get('Message');
        testMessage = new Message({},{},{routingKey:'test.route.key'});
        sinon.stub(testMessage);
                
        var Subscription = helper.injector.get('Subscription');
        testSubscription = new Subscription({},{});
        sinon.stub(testSubscription);
    });

    beforeEach(function () {
        waterline.workitems.startNextScheduled.reset();
        waterline.workitems.setSucceeded.reset();
        waterline.workitems.setFailed.reset();
        waterline.nodes.findOne.reset();
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

    it('should run an IPMI Poller work item', function(done) {
        var workItem = {
            id: 'bc7dab7e8fb7d6abf8e7d6ad',
            name: 'Pollers.IPMI',
            config: {
                command: 'sel',
                ip: '1.2.3.4',
                user: 'myuser',
                password: 'mypass'
            }
        };

        var job = new RunWorkItems({}, { graphId: uuid.v4() }, uuid.v4());
        waterline.workitems.startNextScheduled.onCall(0).resolves(workItem);
        job._publishRunIpmiCommand = sinon.stub().resolves();
        job.run();

        // This is guaranteed to run because job._deferred won't resolve until
        // we call job.cancel()
        setImmediate(function () {
            try {
                expect(job._publishRunIpmiCommand).to.have.been.calledOnce;
                expect(job._publishRunIpmiCommand.firstCall.args[1]).to.equal('sel');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('ip', '1.2.3.4');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('user', 'myuser');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('password', 'mypass');

                job.cancel();
                done();
            } catch (e) {
                done(e);
            }
        });

        return job._deferred;
    });

    it('should run an IPMI Poller work item against a node', function(done) {
        var node = {
            id: 'bc7dab7e8fb7d6abf8e7d6ac',
            obmSettings: [
                {
                    service: 'ipmi-obm-service',
                    config: {
                        ip: '1.2.3.4',
                        user: 'myuser',
                        password: 'mypass'
                    }
                }
            ]
        };
        var workItem = {
            id: 'bc7dab7e8fb7d6abf8e7d6ad',
            name: 'Pollers.IPMI',
            node: node.id,
            config: {
                command: 'power'
            }
        };

        var job = new RunWorkItems({}, { graphId: uuid.v4() }, uuid.v4());
        waterline.workitems.startNextScheduled.onCall(0).resolves(workItem);
        waterline.nodes.findOne.resolves(node);
        job._publishRunIpmiCommand = sinon.stub().resolves();
        job.run();

        // This is guaranteed to run because job._deferred won't resolve until
        // we call job.cancel()
        setImmediate(function () {
            try {
                expect(waterline.nodes.findOne).to.have.been.calledOnce;
                expect(waterline.nodes.findOne).to.have.been.calledWith(node.id);

                expect(job._publishRunIpmiCommand).to.have.been.calledOnce;
                expect(job._publishRunIpmiCommand.firstCall.args[1]).to.equal('power');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('ip', '1.2.3.4');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('user', 'myuser');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('password', 'mypass');
                expect(job._publishRunIpmiCommand.firstCall.args[2])
                    .to.have.property('node', node.id);

                job.cancel();
                done();
            } catch (e) {
                done(e);
            }
        }, 1000);
    });

    it('should run an SNMP Poller work item', function(done) {
        var workItem = {
            id: 'bc7dab7e8fb7d6abf8e7d6ad',
            name: 'Pollers.SNMP',
            config: {
                ip: '1.2.3.4',
                communityString: 'hello'
            }
        };

        var job = new RunWorkItems({}, { graphId: uuid.v4() }, uuid.v4());
        waterline.workitems.startNextScheduled.onCall(0).resolves(workItem);
        job._publishRunSnmpCommand = sinon.stub().resolves();
        job.run();
        
        setImmediate(function () {
            try {
                expect(job._publishRunSnmpCommand).to.have.been.calledOnce;
                expect(job._publishRunSnmpCommand.firstCall.args[1].config)
                    .to.have.property('ip', '1.2.3.4');
                expect(job._publishRunSnmpCommand.firstCall.args[1].config)
                    .to.have.property('communityString', 'hello');
                job.cancel();
                done();
            } catch (e) {
                done(e);
            }
        });
    });
    
    it('should run a Redfish Poller work item', function(done) {
        var workItem = {
            id: 'bc7dab7e8fb7d6abf8e7d6ad',
            name: 'Pollers.Redfish',
            config: {
                uri: 'http://testapi',
                username: 'user',
                password: 'password',
                command: 'power'
            }
        };

        var job = new RunWorkItems({}, { graphId: uuid.v4() }, uuid.v4());
        waterline.workitems.startNextScheduled.onCall(0).resolves(workItem);
        job._publishRunRedfishCommand = sinon.stub().resolves();
        
        job.run();
        setImmediate(function () {
            try {
                expect(job._publishRunRedfishCommand).to.have.been.calledOnce;
                expect(job._publishRunRedfishCommand.firstCall.args[1].config)
                    .to.have.property('uri', 'http://testapi');
                expect(job._publishRunRedfishCommand.firstCall.args[1].config)
                    .to.have.property('username', 'user');
                expect(job._publishRunRedfishCommand.firstCall.args[1].config)
                    .to.have.property('password', 'password');
                job.cancel();
                done();
            } catch (e) {
                done(e);
            }
        });
    });


    it('should mark an unknown work item as failed', function(done) {
        var workItem = {
            id: 'bc7dab7e8fb7d6abf8e7d6ad',
            name: 'Bad Work Item'
        };

        var job = new RunWorkItems({}, { graphId: uuid.v4() }, uuid.v4());

        waterline.workitems.startNextScheduled.onCall(0).resolves(workItem);
        job.run();

        setImmediate(function () {
            try {
                expect(waterline.workitems.setFailed).to.have.been.calledOnce;
                expect(waterline.workitems.setFailed.firstCall.args[1]).to.equal(workItem);
                job.cancel();
                done();
            } catch (e) {
                done(e);
            }
        });
    });
});


