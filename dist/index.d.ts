import { APIGatewayEventRequestContext } from 'aws-lambda';
import { APIGatewayProxyEvent } from 'aws-lambda';
import { ConnectionInitMessage } from 'graphql-ws';
import { DynamoDB } from 'aws-sdk';
import { GraphQLError } from 'graphql';
import { GraphQLResolveInfo } from 'graphql';
import { GraphQLSchema } from 'graphql';
import { PingMessage } from 'graphql-ws';
import { PongMessage } from 'graphql-ws';

export declare interface ApiGatewayManagementApiSubset {
    postToConnection(input: {
        ConnectionId: string;
        Data: string;
    }): {
        promise: () => Promise<any>;
    };
    deleteConnection(input: {
        ConnectionId: string;
    }): {
        promise: () => Promise<any>;
    };
}

export declare interface APIGatewayWebSocketEvent extends APIGatewayProxyEvent {
    requestContext: APIGatewayWebSocketRequestContext;
}

export declare interface APIGatewayWebSocketRequestContext extends APIGatewayEventRequestContext {
    connectionId: string;
    domainName: string;
}

/* Excluded from this release type: Connection */

/**
 * Log operational events with a logger of your choice. It will get a message and usually object with relevant data
 */
export declare type LoggerFunction = (message: string, obj: Record<string, any>) => void;

export declare const makeServer: (opts: ServerArgs) => SubscriptionServer;

export declare type MaybePromise<T> = T | Promise<T>;

export declare interface PubSubEvent {
    topic: string;
    payload: Record<string, any>;
}

export declare interface ServerArgs {
    /**
     * A GraphQL Schema with resolvers
     *
     * You can use `makeExecutableSchema` from [`@graphql-tools/schema`](https://www.npmjs.com/package/@graphql-tools/schema), or `makeSchema` from [`nexus`](https://nexusjs.org/)
     *
     * ```ts
     * import { makeExecutableSchema } from '@graphql-tools/schema
     * // or
     * import { makeSchema } from 'nexus'
     * ```
     */
    schema: GraphQLSchema;
    dynamodb: MaybePromise<DynamoDB>;
    /**
     * An optional ApiGatewayManagementApi object
     */
    apiGatewayManagementApi?: MaybePromise<ApiGatewayManagementApiSubset>;
    /**
     * An optional object or a promise for an object with DDB table names.
     *
     * Defaults to `{ connections: 'graphql_connections', subscriptions: 'graphql_subscriptions' }`
     */
    tableNames?: MaybePromise<{
        connections?: string;
        subscriptions?: string;
    }>;
    /**
     * Makes the context object for all operations defaults to \{ connectionInitPayload, connectionId \}
     */
    context?: ((arg: {
        connectionInitPayload: any;
        connectionId: string;
        publish: SubscriptionServer['publish'];
        complete: SubscriptionServer['complete'];
    }) => MaybePromise<object>) | object;
    /**
     * If set you can use the `stepFunctionsHandler` and a step function to setup a per connection ping/pong cycle to detect disconnects sooner than the 10 minute idle timeout.
     */
    pingpong?: MaybePromise<{
        /**
         * The stateMachineArn for the step function for ping/pong support
         */
        machine: string;
        delay: number;
        timeout: number;
    }>;
    onConnect?: (e: {
        event: APIGatewayWebSocketEvent;
    }) => MaybePromise<void>;
    onDisconnect?: (e: {
        event: APIGatewayWebSocketEvent;
    }) => MaybePromise<void>;
    onConnectionInit?: (e: {
        event: APIGatewayWebSocketEvent;
        message: ConnectionInitMessage;
    }) => MaybePromise<Record<string, any>>;
    onPing?: (e: {
        event: APIGatewayWebSocketEvent;
        message: PingMessage;
    }) => MaybePromise<void>;
    onPong?: (e: {
        event: APIGatewayWebSocketEvent;
        message: PongMessage;
    }) => MaybePromise<void>;
    onError?: (error: any, context: any) => MaybePromise<void>;
    /**
     * Defaults to debug('graphql-lambda-subscriptions') from https://www.npmjs.com/package/debug
     */
    log?: LoggerFunction;
}

export declare interface StateFunctionInput {
    connectionId: string;
    domainName: string;
    stage: string;
    state: 'PING' | 'REVIEW' | 'ABORT';
    seconds: number;
}

/**
 * Creates subscribe handler for use in your graphql schema.
 *
 * `subscribe` is the most important method in the library. It is the primary difference between `graphql-ws` and `graphql-lambda-subscriptions`. It returns a {@link SubscribePseudoIterable} that pretends to be an async iterator that you put on the `subscribe` resolver for your Subscription. In reality it includes a few properties that we use to subscribe to events and fire lifecycle functions. See {@link SubscribeOptions} for information about the callbacks.
 *
 * @param topic - Subscriptions are made to a `string` topic and can be filtered based upon the topics payload.
 * @param options - Optional callbacks for filtering, and lifecycle events.
 */
export declare const subscribe: <T extends PubSubEvent, TRoot extends unknown = any, TArgs extends Record<string, any> = any, TContext extends unknown = any>(topic: T["topic"], options?: SubscribeOptions<T, SubscribeArgs<TRoot, TArgs, TContext>>) => SubscribePseudoIterable<T, SubscribeArgs<TRoot, TArgs, TContext>>;

export declare type SubscribeArgs<TRoot = unknown, TArgs = Record<string, any>, TContext = unknown> = [root: TRoot, args: TArgs, context: TContext, info: GraphQLResolveInfo];

export declare interface SubscribeOptions<T extends PubSubEvent, TSubscribeArgs extends SubscribeArgs = SubscribeArgs> {
    /**
     * An object or a function that returns an object that will be matched against the `payload` of a published event. If the payload's field equals the filter the subscription will receive the event. If the payload is missing the filter's field the subscription will receive the event.
     */
    filter?: SubscriptionFilter<TSubscribeArgs, T['payload']>;
    /**
     * Gets resolver arguments to perform work before a subscription is allowed. This is useful for checking arguments or
     * validating permissions. Return an array of GraphqlErrors if you don't want the subscription to subscribe.
     */
    onSubscribe?: (...args: TSubscribeArgs) => MaybePromise<void | GraphQLError[]>;
    /**
     * Gets resolver arguments to perform work after a subscription saved. This is useful for sending out initial events.
     */
    onAfterSubscribe?: (...args: TSubscribeArgs) => MaybePromise<void>;
    /**
     * Called at least once. Gets resolver arguments to perform work after a subscription has ended. This is useful for bookkeeping or logging. This callback will fire
     *
     * If the client disconnects, sends a `complete` message, or the server sends a `complete` message via the pub/sub system. Because of the nature of aws lambda, it's possible for a client to send a "complete" message immediately disconnect and have those events execute on lambda out of order. Which why this function can be called up to twice.
     */
    onComplete?: (...args: TSubscribeArgs) => MaybePromise<void>;
}

export declare interface SubscribePseudoIterable<T extends PubSubEvent, TSubscribeArgs extends SubscribeArgs = SubscribeArgs> {
    (...args: TSubscribeArgs): AsyncGenerator<T, never, unknown>;
    topic: string;
    filter?: SubscriptionFilter<TSubscribeArgs, T['payload']>;
    onSubscribe?: (...args: TSubscribeArgs) => MaybePromise<void | GraphQLError[]>;
    onAfterSubscribe?: (...args: TSubscribeArgs) => MaybePromise<void>;
    onComplete?: (...args: TSubscribeArgs) => MaybePromise<void>;
}

/* Excluded from this release type: Subscription */

export declare type SubscriptionFilter<TSubscribeArgs extends SubscribeArgs = SubscribeArgs, TReturn extends Record<string, any> = Record<string, any>> = Partial<TReturn> | void | ((...args: TSubscribeArgs) => MaybePromise<Partial<TReturn> | void>);

export declare interface SubscriptionServer {
    /**
     * The handler for your websocket functions
     */
    webSocketHandler: (event: APIGatewayWebSocketEvent) => Promise<WebSocketResponse>;
    /**
     * The handler for your step functions powered ping/pong support
     */
    stepFunctionsHandler: (input: StateFunctionInput) => Promise<StateFunctionInput>;
    /**
     * Publish an event to all relevant subscriptions. This might take some time depending on how many subscriptions there are.
     *
     * The payload if present will be used to match against any filters the subscriptions might have.
     */
    publish: (event: {
        topic: string;
        payload: Record<string, any>;
    }, excludeKeys?: string[]) => Promise<void>;
    /**
     * Send a complete message and end all relevant subscriptions. This might take some time depending on how many subscriptions there are.
     *
     * The payload if present will be used to match against any filters the subscriptions might have.
     */
    complete: (event: {
        topic: string;
        payload?: Record<string, any>;
    }, excludeKeys?: string[]) => Promise<void>;
}

export declare type WebSocketResponse = {
    statusCode: number;
    headers?: Record<string, string>;
    body: string;
};

export { }
