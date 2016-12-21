# rabbit-hapi
HAPI plugin to wrap basic RabbitMQ operations based on [amqp library](https://github.com/squaremo/amqp.node) for NodeJS.

This plugin enables these RabbitMQ operations :
    - pub/sub
    - send to queue or exchange
    - consume messages from queue or exchange
    - send a request in RPC mode

For further informations about RabbitMQ possibilities, see [RabbitMQ official documentation](https://www.rabbitmq.com/getstarted.html).

## Installation

```bash
npm install --save rabbit-hapi
```

## Usage

```javascript
server.register({
    plugin  : require('rabbit-hapi'),
    options : {}
});
```

## Options

### Global settings

Global settings use for broker connection.

| Params        | Description                                       | Default   |
| ---           | ---                                               | ---       |
| hostname      | RabbitMQ broker hostname                          | localhost |
| port          | Port for AMQP                                     | 5672      |
| credentials   | Credential to connect to RabbitMQ broker          | -         |
| heartbeat     | Period of the connection heartbeat (seconds)      | 30        |
| maxRetry      | Max retry allowed on connection or channel error  | 5         |

### RabbitMQ settings

Default settings applied on queues/exchanges.

| Params            | Description                                                   | Default   |
| ---               | ---                                                           | ---       |
| type              | Exchange type                                                 | direct    |
| options           | Queue options                                                 | -         |
| options.durable   | Durable options for queue                                     | true      |
| options.noAck     | Disable acknowledgement on messages if true                   | false     |
| options.RPCExpire | Expiration time (milliseconds) for answer queue in RPC mode   | 60000     |

### Messages settings

Default messages settings.

| Params                | Description                                       | Default           |
| ---                   | ---                                               | ---               |
| content               | Message content                                   | -                 |
| options               | Message options                                   | -                 |
| options.contentType   | Content MIME type                                 | application/json  |
| options.persistent    | If true, message will survive a broker restart    | true              |

## Server Methods

### publish

Publish a message through a fanout exchange.

#### Parameters

| Field             | Type          | Description                                                               |
| ---               | ---           | ---                                                                       |
| message           | Object/String | Message to publish (if string, automatically assign to message.content)   |
| message.content   | *             | Message content                                                           |
| message.options   | Object        | Message options (same as those provided by amqp lib)                      |
| exchange          | String        | Exchange name                                                             |
| options           | Object        | Exchange options                                                          |
| routingKey        | String        | (optional) Routing key to use                                             |
| queue             | String        | (optional) Queue name                                                     |

#### Usage

```javascript
rabbitHapi.publish({
    exchange    : 'publishExchange',
    options     : {
        durable     : false
    },
    message     : 'Hello World !'
}).then(() => {
    // do some stuff here...
}).catch(() => {
    // something went wrong...
});
```

### subscribe

Subscribe to a fanout exchange.

#### Parameters

| Field             | Type          | Description                                                               |
| ---               | ---           | ---                                                                       |
| exchange          | String        | Exchange name                                                             |
| options           | Object        | Exchange options                                                          |
| queue             | String        | (optional) Queue name                                                     |
| waitingFunc       | Function      | Function to call when starting consuming                                  |
| receiveFunc       | Function      | Function to call on message reception                                     |

#### Usage

```javascript
rabbitHapi.subscribe({
    exchange    : 'publishExchange',
    options     : {
        durable     : false,
        noAck       : false,
        exclusive   : true
    },
    receiveFunc : (message) => {
        console.log('Receive', message.content.toString());
    },
    waitingFunc : () => {
        console.log('Waiting for message');
    }
});
```

### send

Send a message to an exchange or a queue. If both `routing key` and `queue` are specified, bind the exchange to the queue using the routing key.
In order to use queue generated from amqp (*amq.gen...*), you need to specified the parameter `generatedQueue`.

#### Parameters

| Field             | Type          | Description                                                               |
| ---               | ---           | ---                                                                       |
| message           | Object/String | Message to publish (if string, automatically assign to message.content)   |
| message.content   | *             | Message content                                                           |
| message.options   | Object        | Message options (same as those provided by amqp lib)                      |
| exchange          | String        | Exchange name                                                             |
| type              | String        | Exchange type                                                             |
| options           | Object        | Exchange options                                                          |
| routingKey        | String        | (optional) Routing key to use                                             |
| queue             | String        | (optional) Queue name                                                     |
| generatedQueue    | Boolean       | (optional) True to use queue generated by the broker                      |

#### Usage

```javascript
rabbitHapi.send({
    queue       : 'hello',
    options     : {
        durable : false,
        noAck   : false
    },
    message     : 'Hello World !'
}).then(() => {
    // do some stuff....
}).catch(() => {
    // something went wrong...
});
```

### consume

Consume messages from an exchange or a queue. Automatic reconnection to a new channel on connection error/lost.

#### Parameters

| Field             | Type          | Description                                                               |
| ---               | ---           | ---                                                                       |
| exchange          | String        | Exchange name                                                             |
| type              | String        | Exchange type                                                             |
| options           | Object        | Exchange options                                                          |
| prefetch          | Number        | Specify prefetch on the channel                                           |
| queue             | String        | (optional) Queue name                                                     |
| waitingFunc       | Function      | Function to call when starting consuming                                  |
| receiveFunc       | Function      | Function to call on message reception                                     |

#### Usage

```javascript
rabbitHapi.consume({
    queue       : 'hello',
    options     : {
        durable : false,
        noAck   : false
    },
    receiveFunc : (message) => {
        console.log('Direct message receive ', message.content.toString());
    },
    waitingFunc : () => {
        console.log('Waiting for message');
    }
});
```

### bindExchange

Bind a key (or an array of keys) to exchange/queue. Create the exchange and/or the queue if it doesn't exist.

#### Parameters

| Field             | Type              | Description                                                               |
| ---               | ---               | ---                                                                       |
| exchange          | String            | Exchange name                                                             |
| type              | String            | Exchange type                                                             |
| options           | Object            | Exchange options                                                          |
| queue             | String            | (optional) Queue name                                                     |
| routingKeys       | String/String[]   | Routing keys to bind to                                                   |
 
#### Usage

```javascript
rabbitHapi.bindExchange({
    exchange    : 'logExchange',
    type        : 'direct',
    queue       : 'logQueue',
    routingKeys : [ 'error', 'info', 'debug' ],
    options     : {
        durable     : true,
        noAck       : false
    }
});
```

### sendRPC

Send a message acting like a client RPC.

#### Parameters

| Field             | Type          | Description                                                               |
| ---               | ---           | ---                                                                       |
| message           | Object/String | Message to publish (if string, automatically assign to message.content)   |
| message.content   | *             | Message content                                                           |
| message.options   | Object        | Message options (same as those provided by amqp lib)                      |
| queue             | String        | Queue to send request on                                                  |
| options           | Object        | Exchange options                                                          |
| receiveFunc       | Function      | Function to call on server response                                       |

#### Usage

```javascript
rabbitHapi.sendRPC({
    queue       : 'rpc_queue',
    options     : {
        durable : false,
        noAck   : false
    },
    message     : 'Hello RPC server !',
    receiveFunc : (answer) => {
        console.log('Server answer with', answer.content.toString());
        // do some stuff...
    }
});
```

### answerToRPC

Answer to an RPC request.

*Note : answer queue is specified and not exclusive in order to enable retry on connection loss.*

#### Parameters

| Field             | Type          | Description                                                                                       |
| ---               | ---           | ---                                                                                               |
| prefetch          | Number        | Specify prefetch on the channel                                                                   |
| queue             | String        | Queue to send the response on                                                                     |
| options           | Object        | Exchange options                                                                                  |
| waitingFunc       | Function      | Function to call when starting consuming                                                          |
| receiveFunc       | Function      | Function to call on message reception (return value of the function will be send to client RPC)   |

#### Usage

```javascript
rabbitHapi.answerToRPC({
    queue       : 'rpc_queue',
    options     : {
        durable     : false,
        noAck       : false
    },
    receiveFunc : (message) => {
        console.log('Message received', message.content.toString(), '... sending response...');
        return 'Hello client !';
    }
});
```