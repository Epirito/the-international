import { RESULT_ACTION, RESULT_FAIL, RESULT_NO_ACTION, RESULT_SUCCESS } from 'international/constants'
import { globalStatsUpdater } from 'international/statsManager'
import {
    customLog,
    findCoordsInsideRect,
    findObjectWithID,
    getRange,
    getRangeOfCoords,
    scalePriority,
} from 'international/utils'
import { packCoord, packPos, reversePosList, unpackPos } from 'other/codec'
import { Hauler } from './hauler'

export class SourceHarvester extends Creep {
    constructor(creepID: Id<Creep>) {
        super(creepID)
    }

    public get dying() {
        // Inform as dying if creep is already recorded as dying

        if (this._dying !== undefined) return this._dying

        // Stop if creep is spawning

        if (this.spawning) return false

        // If the creep's remaining ticks are more than the estimated spawn time plus travel time, inform false

        if (this.ticksToLive > this.body.length * CREEP_SPAWN_TIME + (this.room.sourcePaths[this.memory.SI].length - 1))
            return false

        // Record creep as dying

        return (this._dying = true)
    }

    preTickManager() {
        const { room } = this

        if (this.memory.SI !== undefined && !this.dying) room.creepsOfSource[this.memory.SI].push(this.name)

        // Unpack the harvestPos

        const harvestPos = this.findSourcePos(this.memory.SI)
        if (!harvestPos) return

        if (getRangeOfCoords(this.pos, harvestPos) === 0) {
            this.advancedHarvestSource(this.room.sources[this.memory.SI])
        }
    }

    travelToSource?(): number {
        if (this.worked) return RESULT_SUCCESS

        this.message = '🚬'

        // Unpack the harvestPos

        const harvestPos = this.findSourcePos(this.memory.SI)
        if (!harvestPos) return RESULT_FAIL

        // If the creep is at the creep's packedHarvestPos, inform false

        if (getRangeOfCoords(this.pos, harvestPos) === 0) return RESULT_SUCCESS

        // If the creep's movement type is pull

        if (this.memory.getPulled) return RESULT_NO_ACTION

        // Otherwise say the intention and create a moveRequest to the creep's harvestPos, and inform the attempt

        this.message = `⏩${this.memory.SI}`

        if (this.memory.PC === packCoord(this.room.sourcePositions[this.memory.SI][0])) {
            this.createMoveRequestByPath(
                {
                    origin: this.pos,
                    goals: [
                        {
                            pos: harvestPos,
                            range: 0,
                        },
                    ],
                    avoidEnemyRanges: true,
                },
                {
                    packedPath: reversePosList(this.room.memory.SPs[this.memory.SI]),
                    loose: true,
                },
            )

            return RESULT_ACTION
        }

        this.createMoveRequest({
            origin: this.pos,
            goals: [
                {
                    pos: harvestPos,
                    range: 0,
                },
            ],
            avoidEnemyRanges: true,
        })

        return RESULT_ACTION
    }

    transferToSourceStructures?(): boolean {
        // If the creep is not nearly full, stop

        if (this.store.getCapacity() - this.nextStore.energy > 0) return false

        if (this.transferToSourceExtensions()) return true
        if (this.transferToSourceLink()) return true
        return false
    }

    transferToSourceExtensions?(): boolean {
        const { room } = this

        // If all spawningStructures are filled, inform false

        if (room.energyAvailable === room.energyCapacityAvailable) return false

        const structure = room.findStructureInsideRect(
            this.pos.x - 1,
            this.pos.y - 1,
            this.pos.x + 1,
            this.pos.y + 1,
            structure => {
                return (
                    structure.structureType === STRUCTURE_EXTENSION &&
                    (structure as AnyStoreStructure).store.getCapacity(RESOURCE_ENERGY) - structure.nextStore.energy > 0
                )
            },
        )
        if (!structure) return false

        return this.advancedTransfer(structure as AnyStoreStructure)
    }

    transferToSourceLink?(): boolean {
        const { room } = this

        // Find the sourceLink for the creep's source, Inform false if the link doesn't exist

        const sourceLink = room.sourceLinks[this.memory.SI]
        if (!sourceLink) return false

        // Try to transfer to the sourceLink and inform true

        return this.advancedTransfer(sourceLink)
    }

    repairSourceContainer?(sourceContainer: StructureContainer): boolean {
        if (this.worked) return false
        if (!sourceContainer) return false

        // Get the creep's number of work parts

        const workPartCount = this.parts.work

        // If the sourceContainer doesn't need repairing, inform false

        if (sourceContainer.hitsMax - sourceContainer.hits < workPartCount * REPAIR_POWER) return false

        // If the creep doesn't have enough energy and it hasn't yet moved resources, withdraw from the sourceContainer

        if (this.nextStore.energy < workPartCount && !this.movedResource)
            this.withdraw(sourceContainer, RESOURCE_ENERGY)

        // Try to repair the target

        const repairResult = this.repair(sourceContainer)

        // If the repair worked

        if (repairResult === OK) {
            // Record that the creep has worked

            this.worked = true

            // Find the repair amount by finding the smaller of the creep's work and the progress left for the cSite divided by repair power

            const energySpentOnRepairs = Math.min(
                workPartCount,
                (sourceContainer.hitsMax - sourceContainer.hits) / REPAIR_POWER,
                this.store.energy,
            )

            // Add repair points to total repairPoints counter and say the success
            globalStatsUpdater(this.room.name, 'eoro', energySpentOnRepairs)
            this.message = `🔧${energySpentOnRepairs * REPAIR_POWER}`

            // Inform success

            return true
        }

        // Inform failure

        return false
    }

    transferToNearbyCreep?(): boolean {
        const sourceContainer = this.room.sourceContainers[this.memory.SI]
        if (sourceContainer) return false

        const sourceLink = this.room.sourceLinks[this.memory.SI]
        if (sourceLink && sourceLink.RCLActionable) return false

        // If the creep isn't full enough to justify a request

        if (this.nextStore.energy < this.store.getCapacity() * 0.5) return false

        this.room.createRoomLogisticsRequest({
            target: this,
            type: 'withdraw',
            priority: scalePriority(this.store.getCapacity(), this.reserveStore.energy, 5, true),
        })
        return true
    }

    run?() {
        if (this.travelToSource() !== RESULT_SUCCESS) return
        if (this.transferToSourceStructures()) return

        // Try to repair the sourceContainer

        this.repairSourceContainer(this.room.sourceContainers[this.memory.SI])

        if (this.transferToNearbyCreep()) return
    }

    static sourceHarvesterManager(room: Room, creepsOfRole: string[]): void | boolean {
        // Loop through the names of the creeps of the role

        for (const creepName of creepsOfRole) {
            const creep: SourceHarvester = Game.creeps[creepName]
            creep.run()
        }
    }
}
