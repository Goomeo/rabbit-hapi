'use strict';

var _             = require('underscore'),
    amqp          = require('amqplib'),
    EventEmitter  = require('events').EventEmitter,
    hoek          = require('hoek'),
    uuid          = require('node-uuid'),
    when          = require('when');

var amqpConnect     = undefined,
    rabbitURL       = '',
    retry           = 0;

const events        = new EventEmitter(),
    defaultRabbit   = {
        exchange            : '',
        queue               : '',
        type                : 'direct',
        options             : {
            durable         : true,
            noAck           : false,
            RPCExpire       : 60000
        },
        receiveFunc         : () => {},
        waitingFunc         : () => {}
    },
    defaultMessage  = {
        content         : '',
        options         : {
            contentType : 'application/json',
            persistent  : true
        }
    };

const rabbitPlugin = {
    _server     : {},

    _settings   : {
        hostname    : 'localhost',
        port        : '5672',
        credentials : '',
        heartbeat   : 60,
        maxRetry    : 5
    },

    /**
     * Close the amqp connection on error
     *
     * @param       {object}    err         Error object
     * @returns     {boolean}               True if amqp connection was close due to error
     * @private
     */
    _closeOnErr : (err) => {
        if (!err) {
            return false;
        }

        rabbitPlugin._server.log([ 'error', 'AMQP' ], err.message);

        if (!_.isUndefined(amqpConnect)) {
            amqpConnect.close();
        }

        return true;
    },

    /**
     * Connect to a rabbitMQ server
     *
     * @returns     {object}    AMQP server connection
     * @private
     */
    _connect : () => {
        var options = rabbitPlugin._settings,
            reconnect = () => {
                if (retry >= options.maxRetry) {
                    var err = new Error('[AMQP] cannot reconnect to AMQP server');

                    err.error = {
                        code    : 504,
                        devMsge : '[AMQP] cannot reconnect to AMQP server',
                        usrMsge : '[AMQP] cannot reconnect to AMQP server'
                    };
                    throw err;
                }

                amqpConnect = undefined;
                retry++;
                _.delay(() => { return rabbitPlugin._connect(); }, 1000);
            };

        rabbitURL = 'amqp://' + (_.isEmpty(options.credentials) ? '' : options.credentials + '@') + options.hostname + ':' + options.port;

        if (!_.isUndefined(amqpConnect)) {
            return amqpConnect;
        }

        amqpConnect = amqp.connect(rabbitURL)
            .then((connection) => {
                connection.on('error', (err) => {
                    if (err.message !== 'Connection closing') {
                        rabbitPlugin._server.log([ 'error', 'AMQP', 'connection' ], err.message);
                    }
                });

                connection.on('close', () => {
                    rabbitPlugin._server.log([ 'info', 'AMQP', 'connection' ],  'trying to reconnect');
                    return reconnect();
                });

                rabbitPlugin._server.log([ 'info', 'AMQP', 'connection' ], 'connected');

                if (retry != 0) {
                    events.emit('reconnect');
                }

                retry = 0;
                return connection;
            })
            .catch((err) => {
                rabbitPlugin._server.log([ 'error', 'AMQP', 'connection' ], err.message);
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
    _channel : () => {
        return rabbitPlugin._connect()
            .then((connection) => {
                if (_.isUndefined(connection)) {
                    throw new Error('[AMQP] connection lost');
                }

                return connection.createChannel();
            }).then((channel) => {
                channel.on('error', (err) => {
                    rabbitPlugin._server.log([ 'error', 'AMQP', 'channel' ], err.message);
                });

                channel.on('close', () => {
                    rabbitPlugin._server.log([ 'info', 'AMQP', 'channel' ], 'channel closed');
                });

                return channel;
            }).catch(rabbitPlugin._closeOnErr);
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
    _consume : (params) => {
        return params.channel.consume(params.queue, (message) => {
            when.promise((resolve, reject) => {
                var res;

                try {
                    res = params.receiveFunc(message);

                    if (!params.options.noAck) {
                        params.channel.ack(message);
                    }
                } catch (err) {
                    if (!params.options.noAck) {
                        params.channel.nack(message);
                    }
                    reject(err);
                }
                resolve(res);
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
    _bind : (channel, queue, settings) => {
        return channel.bindQueue(queue, settings.exchange, settings.routingKey).then(() => {
            return queue;
        });
    },

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
    publish : (params) => {
        if (typeof params.message === 'string') {
            params.message = { content : params.message };
        }

        return rabbitPlugin._channel().then((channel) => {
            var settings    = hoek.applyToDefaults(defaultRabbit, params),
                message     = hoek.applyToDefaults(defaultMessage, params.message);

            return channel.assertExchange(settings.exchange, 'fanout', settings.options).then(() => {
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
    subscribe : (params) => {
        var settings    = hoek.applyToDefaults(defaultRabbit, params),
            subFunc     = (channel) => {
                return channel.assertExchange(settings.exchange, 'fanout', settings.options).then(() => {
                    return channel.assertQueue(settings.queue, settings.options);
                }).then((queueOk) => {
                    return rabbitPlugin._bind(channel, queueOk.queue, settings);
                }).then((queue) => {
                    return rabbitPlugin._consume({
                        channel     : channel,
                        queue       : queue,
                        options     : settings.options,
                        receiveFunc : settings.receiveFunc
                    });
                }).then(settings.waitingFunc);
            };

        events.on('reconnect', () => {
            return rabbitPlugin._channel().then(subFunc);
        });

        return rabbitPlugin._channel().then(subFunc);
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
     * @param       {string}        [params.queue]              Queue to send in if no routing key is specified (default to queue '')
     * @returns     {*}
     */
    send : (params) => {
        if (typeof params.message === 'string') {
            params.message = { content : params.message };
        }

        return rabbitPlugin._channel().then((channel) => {
            var settings    = hoek.applyToDefaults(defaultRabbit, params),
                message     = hoek.applyToDefaults(defaultMessage, params.message);

            if (!_.isEmpty(settings.exchange)) {
                // messages using routing key and exchange
                return channel.assertExchange(settings.exchange, settings.type, settings.options).then(() => {
                    channel.publish(settings.exchange, settings.routingKey || settings.queue, new Buffer(message.content), message.options);
                    return channel.close();
                });
            }

            // message direct to a queue
            return channel.assertQueue(settings.queue, settings.options).then(() => {
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
    consume : (params) => {
        var settings    = hoek.applyToDefaults(defaultRabbit, params),
            func        = () => {
                return rabbitPlugin._channel().then((channel) => {
                    var prefetch = (queue) => {
                            if (!_.isUndefined(settings.prefetch) && !_.isNaN(settings.prefetch)) {
                                channel.prefetch(settings.prefetch);
                            }
                            return queue;
                        },
                        consume = (queue) => {
                            return rabbitPlugin._consume({
                                channel     : channel,
                                queue       : queue,
                                options     : settings.options,
                                receiveFunc : settings.receiveFunc
                            });
                        };

                    if (!_.isEmpty(settings.exchange)) {
                        return channel.assertExchange(settings.exchange, settings.type, settings.options).then(() => {
                            return channel.assertQueue(settings.queue, settings.options);
                        }).then((queueOk) => {
                            return rabbitPlugin._bind(channel, queueOk.queue, settings);
                        }).then(prefetch)
                            .then(consume)
                            .then(settings.waitingFunc);
                    }

                    return channel.assertQueue(settings.queue, settings.options)
                        .then((queueOk) => { return queueOk.queue; })
                        .then(prefetch)
                        .then(consume)
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
    bindExchange : (params) => {
        var settings    = hoek.applyToDefaults(defaultRabbit, params);

        return rabbitPlugin._channel().then((channel) => {
            return channel.assertExchange(settings.exchange, settings.type, settings.options)
                .then(() => {
                    return channel.assertQueue(settings.queue, settings.options);
                }).then(() => {
                    if (typeof settings.routingKeys == 'string') {
                        settings.routingKeys = [ settings.routingKeys ];
                    }

                    return when.map(settings.routingKeys, (routingKey) => {
                        return channel.bindQueue(settings.queue, settings.exchange, routingKey);
                    });
                }).then(() => {
                    return channel.close();
                });
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
    sendRPC : (params) => {
        var answerQueue,
            func = () => {
                return rabbitPlugin._channel().then((channel) => {
                    var settings        = hoek.applyToDefaults(defaultRabbit, params),
                        message         = hoek.applyToDefaults(defaultMessage, params.message),
                        answer          = when.defer(),
                        correlationId   = uuid.v1(),
                        getReplyFunc    = (msg) => {
                            if (msg.properties.correlationId === correlationId) {
                                answer.resolve(msg);
                            }
                        },
                        q;

                    // create anonymous exclusive queue for the reply
                    if (_.isUndefined(answerQueue)) {
                        q = channel.assertQueue('', { expires : settings.options.RPCExpire }).then((queueOk) => {
                            answerQueue = queueOk.queue;
                            return queueOk.queue;
                        });
                    } else {
                        q = when(answerQueue);
                    }

                    return q.then((queue) => {
                        rabbitPlugin._consume({
                            channel     : channel,
                            queue       : queue,
                            options     : settings.options,
                            receiveFunc : getReplyFunc
                        });
                        return queue;
                    }).then((queue) => {
                        // sending the message with replyTo set with the anonymous queue
                        var msgOpt = _.extend({}, message.options, {
                            correlationId   : correlationId,
                            replyTo         : queue
                        });

                        channel.assertQueue(settings.queue, settings.options)
                            .then((queueOk) => {
                                channel.publish('', queueOk.queue, new Buffer(message.content), msgOpt);
                            });
                        return answer.promise;
                    }).then((msg) => {
                        settings.receiveFunc(msg);
                        return msg;
                    }).then((msg) => {
                        channel.close();
                        return msg;
                    });
                });
            };

        if (typeof params.message === 'string') {
            params.message = { content : params.message };
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
    answerToRPC : (params) => {
        var func = () => {
            return rabbitPlugin._channel().then((channel) => {
                var settings    = hoek.applyToDefaults(defaultRabbit, params),
                    reply       = (msg, res) => {
                        // reply to client
                        // opening another connection to avoid breaking in middle of the answer
                        return amqp.connect(rabbitURL).then((connection) => {
                            return when(connection.createChannel().then((channel) => {
                                channel.sendToQueue(msg.properties.replyTo, new Buffer(res.content),
                                    _.extend({}, res.options, { correlationId : msg.properties.correlationId }));
                                return channel.close();
                            })).ensure(() => {
                                return connection.close();
                            });
                        });
                    },
                    response    = (msg) => {
                        var res;

                        return when.resolve(settings.receiveFunc(msg)).then((answer) => {
                            if (typeof answer === 'string') {
                                answer = { content : answer };
                            }

                            res = hoek.applyToDefaults(defaultMessage, answer);
                            return res;
                        }).catch((err) => {
                            res = hoek.applyToDefaults(defaultMessage, {
                                content     : err,
                                options     : {
                                    type    : 'error'
                                }
                            });
                        }).finally(() => {
                            return reply(msg, res);
                        });
                    };

                return channel.assertQueue(settings.queue, settings.options).then((queueOk) => {
                    return queueOk.queue;
                }).then((queue) => {
                    if (!_.isUndefined(settings.prefetch) && !_.isNaN(settings.prefetch)) {
                        channel.prefetch(settings.prefetch);
                    }
                    return queue;
                }).then((queue) => {
                    return rabbitPlugin._consume({
                        channel     : channel,
                        queue       : queue,
                        options     : settings.options,
                        receiveFunc : response
                    });
                }).then(settings.waitingFunc);
            });
        };

        events.on('reconnect', func);
        return func();
    },

    register : (server, options, next) => {
        rabbitPlugin._settings = _.extend({}, rabbitPlugin._settings, options);
        rabbitPlugin._server = server;

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

