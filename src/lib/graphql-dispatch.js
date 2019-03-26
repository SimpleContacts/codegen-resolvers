// @flow strict
/* eslint-disable complexity */

import {
    GraphQLEnumType,
    GraphQLInputObjectType,
    GraphQLInterfaceType,
    GraphQLList,
    GraphQLNonNull,
    GraphQLObjectType,
    GraphQLScalarType,
    GraphQLUnionType,
} from 'graphql';
import type { GraphQLInputType, GraphQLOutputType } from 'graphql';

type GraphQLNullableInputType =
    | GraphQLScalarType
    | GraphQLEnumType
    | GraphQLInputObjectType
    | GraphQLList<GraphQLInputType>;

type GraphQLNullableOutputType =
    | GraphQLScalarType
    | GraphQLObjectType
    | GraphQLInterfaceType
    | GraphQLUnionType
    | GraphQLEnumType
    | GraphQLList<GraphQLOutputType>;

type InputTypeDispatchers<O, ContextT> = $Shape<{|
    onScalar: (GraphQLScalarType, ContextT) => O,
    onEnum: (GraphQLEnumType, ContextT) => O,
    onObject: (GraphQLInputObjectType, ContextT) => O,
    onList: (GraphQLList<GraphQLInputType>, ContextT) => O,
    onNonNull: (GraphQLNonNull<GraphQLNullableInputType>, ContextT) => O,
    default: (GraphQLInputType, ContextT) => O,
|}>;

type OutputTypeDispatchers<O, ContextT> = $Shape<{|
    onScalar: (GraphQLScalarType, ContextT) => O,
    onNonNull: (GraphQLNonNull<GraphQLNullableOutputType>, ContextT) => O,
    onObject: (GraphQLObjectType, ContextT) => O,
    onList: (GraphQLList<GraphQLOutputType>, ContextT) => O,
    onEnum: (GraphQLEnumType, ContextT) => O,
    onInterface: (GraphQLInterfaceType, ContextT) => O,
    onUnion: (GraphQLUnionType, ContextT) => O,
    default: (GraphQLOutputType, ContextT) => O,
|}>;

/**
 * Easy function to "dispatch" into one of the given methods.  Given a value of
 * GraphQLOutputType, invokes one of the alternatives for this.  All of the
 * given functions need to return the same shape of result.
 */
export function odispatch<OutputT, ContextT>(
    value: GraphQLOutputType,
    dispatchers: OutputTypeDispatchers<OutputT, ContextT>,
    context: ContextT
): OutputT {
    if (value instanceof GraphQLScalarType && dispatchers.onScalar) {
        return dispatchers.onScalar(value, context);
    } else if (value instanceof GraphQLNonNull && dispatchers.onNonNull) {
        return dispatchers.onNonNull(value, context);
    } else if (value instanceof GraphQLObjectType && dispatchers.onObject) {
        return dispatchers.onObject(value, context);
    } else if (value instanceof GraphQLList && dispatchers.onList) {
        return dispatchers.onList(value, context);
    } else if (value instanceof GraphQLEnumType && dispatchers.onEnum) {
        return dispatchers.onEnum(value, context);
    } else if (value instanceof GraphQLInterfaceType && dispatchers.onInterface) {
        return dispatchers.onInterface(value, context);
    } else if (value instanceof GraphQLUnionType && dispatchers.onUnion) {
        return dispatchers.onUnion(value, context);
    } else {
        if (!dispatchers.default) {
            throw new Error(
                `Dispatcher does not handle node of type "${String(value)}", and also does not define a default handler`
            );
        }
        return dispatchers.default(value, context);
    }
}

/**
 * Easy function to "dispatch" into one of the given methods.  Given a value of
 * GraphQLInputType, invokes one of the alternatives for this.  All of the
 * given functions need to return the same shape of result.
 */
export function idispatch<OutputT, ContextT>(
    value: GraphQLInputType,
    dispatchers: InputTypeDispatchers<OutputT, ContextT>,
    context: ContextT
): OutputT {
    if (value instanceof GraphQLScalarType && dispatchers.onScalar) {
        return dispatchers.onScalar(value, context);
    } else if (value instanceof GraphQLEnumType && dispatchers.onEnum) {
        return dispatchers.onEnum(value, context);
    } else if (value instanceof GraphQLInputObjectType && dispatchers.onObject) {
        return dispatchers.onObject(value, context);
    } else if (value instanceof GraphQLList && dispatchers.onList) {
        return dispatchers.onList(value, context);
    } else if (value instanceof GraphQLNonNull && dispatchers.onNonNull) {
        return dispatchers.onNonNull(value, context);
    } else {
        return dispatchers.default(value, context);
    }
}
