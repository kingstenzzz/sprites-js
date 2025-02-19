// ----------------------------------------------------------------------------
// sprites-registry-tests.js
// Enuma Sprites PoC
//
// Copyright (c) 2018 Enuma Technologies Limited.
// https://www.enuma.io/
// ----------------------------------------------------------------------------

const {
    makeProvider, address, col, ZERO_ADDR, ZERO_BYTES32
} = require('../test-helpers.js')
const Sprites = require('../sprites.js')
const ChannelState = require('../channel-state.js')
const Sign = require('../sign.js')
const {toBuffer} = require('ethereumjs-util')

describe('SpritesRegistry', function () {
    let web3Provider, sign, ALICE, BOB, reg, token

    beforeAll(async () => {
        web3Provider = makeProvider()
        sign = Sign.remotely(web3Provider)
        const testDeployment = await Sprites.testDeploy({web3Provider})
        ;({accounts: {ALICE, BOB}} = testDeployment)
        ;({token, reg} = await Sprites.withWeb3Contracts({
            ...testDeployment,
            ownAddress: ALICE
        }))
    })

    afterAll(() => web3Provider.connection.destroy())

    async function newCh(actor1, actor2, deposit) {
        await token.approve(address(reg), 10).send({from: actor1})

        const tx =
            await reg.createWithDeposit(actor2, address(token), deposit)
                .send({from: actor1})

        return parseInt(tx.events.EventInit.returnValues.chId)
    }

    describe('#create', () => {
        let chId

        beforeAll(async () => {
            const tx = await reg.create(BOB, address(token))
                .send({from: ALICE})

            chId = parseInt(tx.events.EventInit.returnValues.chId)
        })

        it('returns a channel ID', async () => {
            expect(chId).toBeGreaterThanOrEqual(0)
        })

        it('state is empty', async () => {
            expect(await reg.getState(chId).call({from: ALICE}))
                .toMatchObject({
                    deposits: ['0', '0'],
                    credits: ['0', '0'],
                    withdrawals: ['0', '0'],
                    round: '-1',
                    amount: '0',
                    expiry: '0',
                    preimageHash: ZERO_BYTES32,
                    recipient: ZERO_ADDR
                })
        })
    })

    describe('#createWithDeposit', () => {
        let chId

        beforeAll(async () => {
            chId = await newCh(ALICE, BOB, 10)
        })

        describe('#getPlayers', () => {
            let players

            beforeAll(async () => {
                players = await reg.getPlayers(chId).call({from: ALICE})
            })

            test('is agnostic to the viewpoint of actors', async () => {
                const chB = await reg.getPlayers(chId).call({from: BOB})
                expect(chB).toEqual(players)
            })
        })

        describe('#getState', () => {
            let ch

            beforeAll(async () => {
                ch = await reg.getState(chId).call({from: ALICE})
            })

            it('has the deposit, but the round stays the same', async () => {
                expect(ch).toMatchObject({
                    deposits: ['10', '0'],
                    round: '-1'
                })
            })

            it('is agnostic to the viewpoint of actors', async () => {
                const chB = await reg.getState(chId).call({from: BOB})
                expect(chB).toEqual(ch)
            })

            describe('#serializeState', async () => {
                it('works the same on-chain and off-chain', async () => {
                    const ch1 = {...ch, chId}
                    const offChain = ChannelState.serialize(ch1)
                    const onChain =
                        await reg.serializeState(...ChannelState.vector(ch1))
                            .call({from: ALICE})

                    expect(col(onChain)).toEqual(col(offChain))
                    expect(toBuffer(onChain)).toHaveLength(320)
                })
            })

            describe('#verifyUpdate', () => {
                it('works with higher round number', async () => {
                    const ch1 = ChannelState.transition(
                        [['withdraw', 0, 3]], {...ch, chId})
                    const BOBsig = await sign(BOB, ChannelState.serialize(ch1))
                    const canUpdate =
                        reg.verifyUpdate(...ChannelState.vector(ch1), BOBsig)
                            .call({from: ALICE})

                    await expect(canUpdate).resolves.toBe(true)
                })

                it('fails, when using round lower than bestRound', async () => {
                    const ch1 = {...ch, round: ch.round - 1, chId}
                    const BOBsig = await sign(BOB, ChannelState.serialize(ch1))
                    const update =
                        reg.verifyUpdate(...ChannelState.vector(ch1), BOBsig)
                            .call({from: ALICE})

                    await expect(update).rejects.toThrowError(/0x/)
                })
            })
        })
    })
})
