'use strict';

const _                 = require('underscore');
const amqp              = require('amqplib');
const EventEmitter      = require('events').EventEmitter;
const hoek              = require('hoek');
const Promise           = require('bluebird');
const uuid              = require('node-uuid');

let amqpConnect     = undefined;
let rabbitURL       = '';
let retry           = 0;

const events        = new EventEmitter();
const defaultRabbit = {
    exchange            : '',
    queue               : '',
    type                : 'direct',
    options             : {
        durable         : true,
        noAck           : false
    },
    RPCTimeout          : 30000,        // 30 sec
    receiveFunc         : () => {},
    waitingFunc         : () => {}
};
const defaultMessage    = {
    content         : '',
    options         : {
        contentType : 'application/json',
        persistent  : true
    }
};

const internals = {
    _server     : {},
    _settings   : {
        hostname        : 'localhost',
        port            : '5672',
        vhost           : '/',
        credentials     : '',
        heartbeat       : 30,
        maxRetry        : 5,
        autoReconnect   : true,
        maxDelay        : 3600000,
        socketOptions   : {
            timeout     : 3000
        }
    },


    /**
     * Close the amqp connection on error
     *
     * @param       {object}    err         Error object
     * @returns     {boolean}               True if amqp connection was close due to error
     * @private
     */
    _closeOnErr(err) {
        if (!_.isUndefined(amqpConnect)) {
            amqpConnect.close();
        }

        throw err;
    },

    /**
     * Connect to a rabbitMQ server
     *
     * @returns     {object}    AMQP server connection
     * @private
     */
    _connect() {
        const options = internals._settings;
        const reconnect = () => {
            if (retry >= options.maxRetry && !options.autoReconnect) {
                let err = new Error('[AMQP] cannot reconnect to AMQP server');

                err.error = {
                    code    : 504,
                    devMsge : '[AMQP] cannot reconnect to AMQP server',
                    usrMsge : '[AMQP] cannot reconnect to AMQP server'
                };
                throw err;
            }

            amqpConnect = undefined;

            let refDelay    = 60000,    // 60 000ms
                range       = Math.floor(retry/5),
                calcDelay   = Math.min(range*(Math.pow(range, 1.5))*refDelay, options.maxDelay);

            if (range == 0) {
                calcDelay = 1000;
            }

            retry++;
            _.delay(() => internals._connect(), calcDelay);
        };

        rabbitURL = 'amqp://' + (_.isEmpty(options.credentials) ? '' : options.credentials + '@') + options.hostname + ':' + options.port + options.vhost;

        if (!_.isUndefined(amqpConnect)) {
            return amqpConnect;
        }

        if (!_.isUndefined(options.heartbeat)) {
            rabbitURL += '?heartbeat=' + options.heartbeat;
        }

        amqpConnect = amqp.connect(rabbitURL, options.socketOptions)
            .then((connection) => {
                connection.on('error', (err) => {
                    if (err.message !== 'Connection closing') {
                        internals._server.log([ 'error', 'AMQP', 'connection' ], err.message);
                    }
                });

                connection.on('close', () => {
                    internals._server.log([ 'info', 'AMQP', 'connection' ],  'trying to reconnect');
                    return reconnect();
                });

                internals._server.log([ 'info', 'AMQP', 'connection' ], 'connected');

                if (retry != 0) {
                    events.emit('reconnect');
                }

                retry = 0;
                return connection;
            })
            .catch((err) => {
                internals._server.log([ 'error', 'AMQP', 'connection' ], err.message);
                return reconnect();
            });

        return amqpConnect;
    },

    /**
     * Create a channel based on current connection to AMQP server
     *
     * @returns     {object}        Channel
     * @private
     */
    _channel() {
        return internals._connect()
            .then((connection) => {
                if (_.isUndefined(connection)) {
                    throw new Error('[AMQP] connection lost');
                }

                return connection.createChannel();
            }).then((channel) => {
                channel.on('error', (err) => {
                    internals._server.log([ 'error', 'AMQP', 'channel' ], err.message);
                });

                channel.on('close', () => {
                    internals._server.log([ 'info', 'AMQP', 'channel' ], 'channel closed');
                });

                return channel;
            })
            .catch(internals._closeOnErr);
    },

    /**
     * Consume messages from a queue
     *
     * @param   {object}    params              Function params
     * @param   {object}    params.channel      Channel to use
     * @param   {object}    params.queue        Queue to use
     * @param   {object}    params.options      Options for the queue
     * @param   {function}  params.receiveFunc  Function to call on consumption
     * @returns {{ticket, queue, consumerTag, noLocal, noAck, exclusive, nowait, arguments}}
     * @private
     */
    _consume(params) {
        return params.channel.consume(params.queue, (message) => {
            return Promise.resolve(params.receiveFunc(message))
                .then(() => {
                    if (!params.options.noAck) {
                        params.channel.ack(message);
                    }
                })
                .catch(() => {
                    if (!params.options.noAck) {
                        params.channel.nack(message);
                    }
                });
        }, params.options);
    },

    /**
     * Wrap channel.bindQueue
     *
     * @param   {object}    channel         Channel in use
     * @param   {object}    queue           Queue to bind
     * @param   {object}    settings        Settings for binding
     * @private
     */
    _bind(channel, queue, settings) {
        return channel.bindQueue(queue, settings.exchange, settings.routingKey)
            .then(() => queue);
    },
};

const rabbitPlugin = {
    /**
     * Publish a message through a fanout exchange
     *
     * @param       {object}        params                      Function params
     * @param       {string|object} params.message              Message to send
     * @param       {*}             [params.message.content]    Message content
     * @param       {object}        [params.message.options]    Message options (same as amqp)
     * @param       {string}        params.exchange             Exchange name
     * @param       {object}        [params.options]            Exchange settings (same as amqp)
     * @param       {string}        [params.routingKey]         Routing key to use
     * @param       {string}        [params.queue]              Queue to send in if no routing key is specified (default to queue '')
     * @returns     {*}
     */
    publish(params) {
        if (typeof params.message === 'string') {
            params.message = {
                content : params.message
            };
        }

        return internals._channel()
            .then((channel) => {
                let settings    = hoek.applyToDefaults(defaultRabbit, params);
                let message     = hoek.applyToDefaults(defaultMessage, params.message);

                return channel.assertExchange(settings.exchange, 'fanout', settings.options)
                    .then(() => {
                        channel.publish(settings.exchange, settings.routingKey || settings.queue, new Buffer(message.content), message.options);
                        return channel.close();
                    });
            });
    },

    /**
     * Subscribe to a fanout exchange. Automatic reconnection to a new channel on connection error/lost.
     *
     * @param       {object}        params                  Function params
     * @param       {string}        params.exchange         Exchange name
     * @param       {object}        [params.options]        Exchange/queue settings (same as amqp)
     * @param       {string}        [params.queue]          Queue to send in if no routing key is specified (default to queue '')
     * @param       {function}      [params.waitingFunc]    Function to call on connection to the channel
     * @param       {function}      params.receiveFunc      Function to call on message consumption (take message object in parameter)
     * @returns {*}
     */
    subscribe(params) {
        let settings    = hoek.applyToDefaults(defaultRabbit, params);
        let subFunc     = (channel) => {
            return channel.assertExchange(settings.exchange, 'fanout', settings.options)
                .then(() => channel.assertQueue(settings.queue, settings.options))
                .then(queueOk => internals._bind(channel, queueOk.queue, settings))
                .then(queue => (
                    internals._consume({
                        channel,
                        queue,
                        options     : settings.options,
                        receiveFunc : settings.receiveFunc
                    })
                ))
                .then(settings.waitingFunc);
        };

        events.on('reconnect', () => {
            return internals._channel()
                .then(subFunc);
        });

        return internals._channel()
            .then(subFunc);
    },

    /**
     * Send a message to an exchange or a queue
     *
     * @param       {object}        params                      Function params
     * @param       {string|object} params.message              Message to send
     * @param       {*}             [params.message.content]    Message content
     * @param       {object}        [params.message.options]    Message options (same as amqp)
     * @param       {string}        [params.exchange]           Exchange name
     * @param       {string}        [params.type]               Exchange type (fanout, direct, topic)
     * @param       {object}        [params.options]            Exchange/queue settings (same as amqp)
     * @param       {string}        [params.queue]              Queue to send in if no routing key is specified
     * @param       {boolean}       [params.generatedQueue]     True to use AMQP auto-generated queue
     * @returns     {*}
     */
    send(params) {
        if (typeof params.message === 'string') {
            params.message = {
                content : params.message
            };
        }

        return internals._channel()
            .then((channel) => {
                let settings    = hoek.applyToDefaults(defaultRabbit, params);
                let message     = hoek.applyToDefaults(defaultMessage, params.message);

                if (!_.isEmpty(settings.exchange)) {
                    // messages using routing key and exchange
                    return channel.assertExchange(settings.exchange, settings.type, settings.options)
                        .then(() => {
                            // if queue is not passed and not anonymous, just use the routing feature from the exchange
                            if (!settings.generatedQueue && _.isEmpty(settings.queue) && !_.isEmpty(settings.routingKey)) {
                                return;
                            }

                            // else, assert the queue exists or create it
                            settings.queue = settings.generatedQueue ? '' : settings.queue;
                            return channel.assertQueue(settings.queue, settings.options);
                        })
                        .then((queueOk) => {
                            if (!queueOk) {
                                return;
                            }

                            // (re)do binding in case of queue creation
                            return internals._bind(channel, queueOk.queue, settings);
                        })
                        .then(() => {
                            channel.publish(settings.exchange, settings.routingKey || settings.queue, new Buffer(message.content), message.options);
                            return channel.close();
                        });
                }

                // message direct to a queue
                return channel.assertQueue(settings.queue, settings.options)
                    .then(() => {
                        channel.publish('', settings.queue, new Buffer(message.content), message.options);
                        return channel.close();
                    });
            });
    },

    /**
     * Consume messages on an exchange or a queue. Automatic reconnection to a new channel on connection error/lost.
     *
     * @param       {object}        params                  Function params
     * @param       {string}        [params.exchange]       Exchange name
     * @param       {string}        [params.type]           Exchange type (fanout, direct, topic)
     * @param       {object}        [params.options]        Exchange/queue settings (same as amqp)
     * @param       {number}        [params.prefetch]       Specify prefetch on the channel
     * @param       {string}        [params.queue]          Queue to send in if no routing key is specified (default to queue '')
     * @param       {function}      [params.waitingFunc]    Function to call on connection to the channel
     * @param       {function}      params.receiveFunc      Function to call on message consumption (take message object in parameter)
     * @returns     {*}
     */
    consume(params) {
        let settings    = hoek.applyToDefaults(defaultRabbit, params);
        let func        = () => {
            return internals._channel()
                .then((channel) => {
                    let chain = Promise.resolve();

                    if (!_.isEmpty(settings.exchange)) {
                        chain = chain
                            .then(() => channel.assertExchange(settings.exchange, settings.type, settings.options))
                            .then(() => channel.assertQueue(settings.queue, settings.options))
                            .then(queueOk => internals._bind(channel, queueOk.queue, settings));
                    } else {
                        chain = chain
                            .then(() => channel.assertQueue(settings.queue, settings.options))
                            .then(queueOk => queueOk.queue);
                    }

                    return chain
                        .then((queue) => {
                            if (!_.isUndefined(settings.prefetch) && !_.isNaN(settings.prefetch)) {
                                channel.prefetch(settings.prefetch);
                            }
                            return queue;
                        })
                        .then(queue => (
                            internals._consume({
                                channel     : channel,
                                queue       : queue,
                                options     : settings.options,
                                receiveFunc : settings.receiveFunc
                            })
                        ))
                        .then(settings.waitingFunc);
                });
        };

        events.on('reconnect', func);
        return func();
    },

    /**
     * Create exchange and queue if it do not exist and bind to specified routing keys.
     *
     * @param       {object}            params                  Function params
     * @param       {string}            params.exchange         Exchange name
     * @param       {string}            params.type             Exchange type (fanout, direct, topic)
     * @param       {object}            [params.options]        Exchange/queue settings (same as amqp)
     * @param       {string}            params.queue            Queue to bind
     * param        {string|string[]}   params.routingKeys      Routing keys to bind to. USe array to specified multiple keys.
     * @returns     {*}
     */
    bindExchange(params) {
        let settings    = hoek.applyToDefaults(defaultRabbit, params);

        return internals._channel()
            .then((channel) => {
                return channel.assertExchange(settings.exchange, settings.type, settings.options)
                    .then(() => channel.assertQueue(settings.queue, settings.options))
                    .then(() => {
                        if (typeof settings.routingKeys == 'string') {
                            settings.routingKeys = [ settings.routingKeys ];
                        }

                        return Promise.map(settings.routingKeys, routingKey => channel.bindQueue(settings.queue, settings.exchange, routingKey));
                    })
                    .then(() => channel.close());
            });
    },

    /**
     * Send a RPC request : send a message on a queue and wait for a response from consumer
     *
     * @param       {object}            params                      Function params
     * @param       {string|object}     params.message              Message to send
     * @param       {*}                 [params.message.content]    Message content
     * @param       {object}            [params.message.options]    Message options (same as amqp)
     * @param       {string}            params.queue                Queue to send
     * @param       {object}            [params.options]            Queue settings (same as amqp)
     * @param       {function}          params.receiveFunc          Function to call server answer
     * @returns     {*}
     */
    sendRPC(params) {
        let func = () => {
            return internals._channel()
                .then((channel) => {
                    let settings    = hoek.applyToDefaults(defaultRabbit, params);
                    let message     = hoek.applyToDefaults(defaultMessage, params.message);

                    let rpcPromise = new Promise((resolve) => {
                        const correlationId = uuid.v1();

                        let replyFunc = (msg) => {
                            if (msg.properties.correlationId === correlationId) {
                                resolve(msg);
                            }
                        };

                        // declare anonyme queue for RPC answer
                        channel.assertQueue('', {
                            exclusive   : true,
                            autoDelete  : true
                        })
                            .then(queueOk => queueOk.queue)
                            .then((answerQueue) => {
                                internals._consume({
                                    channel,
                                    queue       : answerQueue,
                                    options     : {
                                        exclusive   : true
                                    },
                                    receiveFunc : replyFunc
                                });

                                return answerQueue;
                            })
                            .then((queue) => {
                                // sending the message with replyTo set with the anonymous queue
                                let msgOpt = _.extend({}, message.options, {
                                    correlationId   : correlationId,
                                    replyTo         : queue
                                });

                                return channel.assertQueue(settings.queue, settings.options)
                                    .then(queueOk => channel.publish('', queueOk.queue, new Buffer(message.content), msgOpt))
                                    .then(() => queue);
                            });
                    });

                    if (!_.isUndefined(settings.RPCTimeout)) {
                        rpcPromise = rpcPromise.timeout(settings.RPCTimeout)
                            .catch((err) => {
                                channel.close();
                                return Promise.reject(err);
                            });
                    }

                    return rpcPromise
                        .then((msg) => {
                            channel.close();
                            return msg;
                        })
                        .then((msg) => {
                            settings.receiveFunc(msg);
                            return msg;
                        });
                });
        };

        if (typeof params.message === 'string') {
            params.message = {
                content : params.message
            };
        }

        events.on('reconnect', func);
        return func();
    },

    /**
     * Answer to a RPC request
     *
     * @param       {object}            params                  Function params
     * @param       {number}            [params.prefetch]       Specify prefetch on the channel
     * @param       {string}            params.queue            Queue to send
     * @param       {object}            [params.options]        Queue settings (same as amqp)
     * @param       {function}          [params.waitingFunc]    Function to call on connection to the channel
     * @param       {function}          params.receiveFunc      Function to call when receiving a message
     * @return      {*}
     */
    answerToRPC(params) {
        let func = () => {
            return internals._channel()
                .then((channel) => {
                    let settings    = hoek.applyToDefaults(defaultRabbit, params);
                    let reply       = (msg, res) => {
                        // reply to client
                        // opening another connection to avoid breaking in middle of the answer
                        return amqp.connect(rabbitURL)
                            .then((connection) => {
                                return connection.createChannel()
                                    .then((channel) => {
                                        channel.sendToQueue(msg.properties.replyTo, new Buffer(res.content),
                                            _.extend({}, res.options, { correlationId : msg.properties.correlationId }));
                                        return channel.close();
                                    })
                                    .then(() => connection.close());
                            });
                    };
                    let response    = (msg) => {
                        let res;

                        return Promise.resolve(settings.receiveFunc(msg))
                            .then((answer) => {
                                if (typeof answer === 'string') {
                                    answer = { content : answer };
                                }

                                res = hoek.applyToDefaults(defaultMessage, answer);
                                return res;
                            })
                            .catch((err) => {
                                res = hoek.applyToDefaults(defaultMessage, {
                                    content     : err.toString,
                                    options     : {
                                        type    : 'error'
                                    }
                                });
                            })
                            .finally(() => reply(msg, res));
                    };

                    return channel.assertQueue(settings.queue, settings.options)
                        .then(queueOk => queueOk.queue)
                        .then((queue) => {
                            if (!_.isUndefined(settings.prefetch) && !_.isNaN(settings.prefetch)) {
                                channel.prefetch(settings.prefetch);
                            }
                            return queue;
                        })
                        .then((queue) => {
                            return internals._consume({
                                channel,
                                queue,
                                options     : settings.options,
                                receiveFunc : response
                            });
                        })
                        .then(settings.waitingFunc);
                });
        };

        events.on('reconnect', func);
        return func();
    },

    register(server, options, next) {
        internals._settings = _.extend({}, internals._settings, options);
        internals._server = server;

        server.expose('publish', rabbitPlugin.publish);
        server.expose('subscribe', rabbitPlugin.subscribe);
        server.expose('send', rabbitPlugin.send);
        server.expose('consume', rabbitPlugin.consume);
        server.expose('bindExchange', rabbitPlugin.bindExchange);
        server.expose('sendRPC', rabbitPlugin.sendRPC);
        server.expose('answerToRPC', rabbitPlugin.answerToRPC);

        next();
    }
};

rabbitPlugin.register.attributes = {
    pkg : require('./package.json')
};

module.exports.register = rabbitPlugin.register;
