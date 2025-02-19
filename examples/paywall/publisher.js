// ----------------------------------------------------------------------------
// publisher.js
// Enuma Sprites PoC
//
// Copyright (c) 2018 Enuma Technologies Limited.
// https://www.enuma.io/
// ----------------------------------------------------------------------------

const {curry, assoc, project, values, prop} = require('ramda')
const {thread, threadP} = require('sprites-channels/fp.js')
const assert = require('assert')
const {inspect} = require('util')
const {
    BN,
    addHexPrefix,
    bufferToHex,
    toBuffer,
    toUnsigned,
    hashPersonalMessage
} = require('ethereumjs-util')
const H = require('sprites-channels/test-helpers.js')
const {address} = H
const Sign = require('sprites-channels/sign.js')
const ChannelState = require('sprites-channels/channel-state.js')
const Paywall = require('./paywall.js')
const Sprites = require('sprites-channels')

const Publisher = {
    make(opts) {
        return {
            db: undefined,
            sprites: Sprites.make(),
            ...opts
        }
    },

    /**
     * Returns parameters necessary for a Reader to establish
     * payment channels with the Publisher
     * */
    config(publisher) {
        const {sprites: {ownAddress, preimageManager, reg, token}} = publisher
        return {
            publisher: ownAddress,
            preimageManager: address(preimageManager),
            reg: address(reg),
            token: address(token),
        }
    },

    async catalog(publisher) {
        const publicFields = ['id', 'price', 'title', 'blurb']
        return project(publicFields, values(publisher.db))
    },

    /**
     * Create an invoice for an order.
     * */
    invoice: curry(async (order, publisher) => {
        const {db} = publisher
        const {chId, articleId} = order

        const article = db[articleId]
        assert(article, `Missing article for id: ${articleId}`)

        const {price} = article
        assert(price, `Missing price for article id: ${articleId}`)

        const spritesBefore =
            await Sprites.channelState({...publisher.sprites, chId})

        const ownIdx = Sprites.ownIdx(spritesBefore)
        const xforms = [
            ['credit', ownIdx, price],
            ['withdraw', ownIdx, price]]

        const sprites = await threadP(
            spritesBefore,
            Sprites.transition(xforms),
            Sprites.sign)
        const {round, sigs} = sprites.channel

        return {
            ...publisher,
            sprites,
            invoice: {articleId, price, xforms, chId, round, sigs}
        }
    }),

    receiptData({articleId, chId}) {
        return Buffer.concat([Buffer.from(articleId), toUnsigned(new BN(chId))])
    },

    receiptSig: curry(async (unsignedReceipt, publisher) => {
        const {sprites} = publisher
        const sig = await thread(
            unsignedReceipt,
            Publisher.receiptData,
            bufferToHex,
            addHexPrefix,
            publisher.sprites.sign)

        sig.by = {actor: sprites.ACTOR_NAME, addr: sprites.ownAddress}
        sig.receipt = unsignedReceipt
        // sig[inspect.custom] = function () {
        //     return this.by.actor + '('
        //         + this.receipt.articleId
        //         + '|ch' + this.receipt.chId + ')'
        // }
        return sig
    }),

    processPayment: curry(async (payment, publisher) => {
        const {articleId, chId, xforms, sigs} = payment
        const [buyerSig, _sellerSig] = sigs
        assert(buyerSig,
            `Signature missing from payment:\n` + inspect(payment))

        const sprites = await threadP(publisher.sprites,
            assoc('chId', chId),
            Sprites.channelState,
            Sprites.transition(xforms),
            Sprites.withSigs(sigs))

        assert(ChannelState.checkAvailSigs(sprites.channel),
            `Invalid signatures in payment:\n`
            + inspect(payment) + '\n'
            + 'in channel:\n'
            + inspect(sprites.channel))

        const sig = await Publisher.receiptSig({articleId, chId}, publisher)

        await Sprites.save(sprites)
        return {
            ...publisher,
            sprites,
            paymentReceipt: {articleId, chId, sig, payment}
        }
    }),

    getArticle: curry(async (receipt, publisher) => {
        const {sig, articleId} = receipt
        const receiptHash = hashPersonalMessage(Publisher.receiptData(receipt))
        const {sprites} = publisher
        assert(Sign.by(sprites.ownAddress, receiptHash, sig),
            `Invalid signture on receipt:\n` + inspect(receipt))
        // This might be async, hence the whole function is async
        const article = publisher.db[articleId]
        return {...publisher, article}
    }),

    /**
     * Withdraws accumulated payments to the blockchain.
     * */
    publisherWithdraw: curry(async (chId, publisher) => {
        const spritesBefore = (await Paywall.channel(chId, publisher)).sprites
        const spritesAfter = await threadP(
            spritesBefore,
            Sprites.updateAndWithdraw,
            Sprites.channelState,
            Sprites.save)
        const ownIdx = Sprites.ownIdx(spritesAfter)
        const withdrawn =
            spritesAfter.channel.withdrawn[ownIdx] -
            spritesBefore.channel.withdrawn[ownIdx]
        return {...publisher, sprites: spritesAfter, withdrawn}
    }),

    /**
     * Publisher agrees that the reader can withdraw their off-chain balance
     * to the blockchain.
     * */
    readerWithdraw: curry(async (withdrawalRequest, publisher) => {
        const {chId, xforms, sigs} = withdrawalRequest
        const sprites = await threadP(
            {...publisher.sprites, chId},
            Sprites.channelState,
            Sprites.transition(xforms),
            Sprites.withSigs(sigs))

        assert(ChannelState.checkAvailSigs(sprites.channel),
            `Invalid signatures in withdrawalRequest:\n`
            + inspect(withdrawalRequest) + '\n'
            + 'in channel:\n'
            + inspect(sprites.channel))

        const signedSprites = await Sprites.sign(sprites)
        await Sprites.save(signedSprites)
        const withdrawal = {
            ...withdrawalRequest,
            sigs: signedSprites.channel.sigs
        }
        return {...publisher, sprites: signedSprites, withdrawal}
    })
}

module.exports = Publisher
