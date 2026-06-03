/**
 * High-level control for the Andrew Alliance pipetting robot, ported from the
 * `andrew_robot` Python library (robot.py / servo.py) to run entirely in the
 * browser over Web Serial.
 *
 * Coordinates are DYNAMIXEL servo ticks (0–4095) in joint space — there is no
 * Cartesian model — so physical locations are taught by capturing poses.
 */

import { Dynamixel } from './dynamixel.js';

/** MX-28 / MX-106 (Protocol 1.0) control-table addresses we use. */
export const ADDR = {
    CW_ANGLE_LIMIT: 6,
    CCW_ANGLE_LIMIT: 8,
    TORQUE_ENABLE: 24,
    LED: 25,
    D_GAIN: 26,
    I_GAIN: 27,
    P_GAIN: 28,
    GOAL_POSITION: 30,
    MOVING_SPEED: 32,
    TORQUE_LIMIT: 34,
    PRESENT_POSITION: 36,
    PRESENT_SPEED: 38,
    PRESENT_LOAD: 40,
    PRESENT_VOLTAGE: 42,
    PRESENT_TEMPERATURE: 43,
    MOVING: 46,
};

/** Joint name → servo ID (from robot.py _init_servos). */
export const SERVO_ID = {
    shoulder: 1,
    elbow: 2,
    wrist: 3,
    linear: 4,
    thumb: 5,
    gripper: 6,
    twister: 7,
};

export const ARM_JOINTS = ['shoulder', 'elbow', 'wrist', 'linear'];
export const ALL_JOINTS = ['shoulder', 'elbow', 'wrist', 'linear', 'thumb', 'gripper', 'twister'];

/** Defaults mirror robot.py; all overridable from the UI config. */
export const ROBOT_DEFAULTS = {
    SAFE_HEIGHT: 1600,
    GRAB_HEIGHT: 2035,
    GRIPPER_CLOSED_LOAD: 250,
    GRIPPER_CLOSED_POSITION: 2100,
    GRIPPER_OPEN_POSITION: 2531,
    THUMB_NEUTRAL_POSITION: 1700,
    THUMB_DEPRESS_FIRST_POSITION: 2970,
    THUMB_DEPRESS_SECOND_POSITION: 3050,
    THUMB_EJECT_POSITION: 1498,
    ARM_LED_ID: 1,
    BODY_LED_ID: 2,
    POSITION_ERROR_MARGIN: 12,
    MAX_SPEED: 60,
    MOVE_TIMEOUT_MS: 12000,
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class AndrewRobot {
    /**
     * @param {object} opts
     * @param {import('../arduino/serialIO.js').SerialIO} opts.servoIO  opened @250000
     * @param {import('../arduino/serialIO.js').SerialIO|null} [opts.ledIO]  opened @9600
     * @param {object} [opts.config]  overrides for ROBOT_DEFAULTS
     * @param {(msg:string)=>void} [opts.onLog]
     */
    constructor({ servoIO, ledIO = null, config = {}, onLog = () => {} }) {
        this.dxl = new Dynamixel(servoIO);
        this.ledIO = ledIO;
        this.cfg = { ...ROBOT_DEFAULTS, ...config };
        this.onLog = onLog;
        this._maxSpeed = this.cfg.MAX_SPEED;
        this._aborted = false;
    }

    log(msg) {
        try {
            this.onLog(msg);
        } catch {
            /* ignore */
        }
    }

    /** Signal all in-progress / future moves to stop ASAP. */
    abort() {
        this._aborted = true;
    }

    clearAbort() {
        this._aborted = false;
    }

    _checkAbort() {
        if (this._aborted) throw new Error('Aborted');
    }

    // ---- low-level per-joint helpers -------------------------------------

    async readPosition(joint) {
        return this.dxl.readInt(SERVO_ID[joint], ADDR.PRESENT_POSITION, 2);
    }

    async readAllPositions(joints = ALL_JOINTS) {
        const out = {};
        for (const j of joints) {
            try {
                out[j] = await this.readPosition(j);
            } catch {
                out[j] = null;
            }
        }
        return out;
    }

    async readTemperature(joint) {
        return this.dxl.readInt(SERVO_ID[joint], ADDR.PRESENT_TEMPERATURE, 1);
    }

    async setSpeed(joint, speed) {
        await this.dxl.writeInt(SERVO_ID[joint], ADDR.MOVING_SPEED, 2, Math.max(0, Math.min(1023, speed | 0)));
    }

    async setMaxSpeed(speed) {
        this._maxSpeed = Math.max(1, Math.min(1023, speed | 0));
        for (const j of ARM_JOINTS.concat(['thumb', 'gripper'])) {
            try {
                await this.setSpeed(j, this._maxSpeed);
            } catch {
                /* ignore individual */
            }
        }
    }

    get maxSpeed() {
        return this._maxSpeed;
    }

    async enableTorque(joint) {
        await this.dxl.writeInt(SERVO_ID[joint], ADDR.TORQUE_ENABLE, 1, 1);
    }

    async disableTorque(joint) {
        await this.dxl.writeInt(SERVO_ID[joint], ADDR.TORQUE_ENABLE, 1, 0);
    }

    /** Enable holding torque on every servo. */
    async enableAllTorque() {
        for (const j of ALL_JOINTS) {
            try {
                await this.enableTorque(j);
            } catch {
                /* ignore */
            }
        }
    }

    /** Cut torque on every servo — used for E-STOP and for free-hand teaching. */
    async disableAllTorque() {
        for (const j of ALL_JOINTS) {
            try {
                await this.disableTorque(j);
            } catch {
                /* ignore */
            }
        }
    }

    async ping() {
        const present = {};
        for (const j of ALL_JOINTS) {
            present[j] = await this.dxl.ping(SERVO_ID[j]);
        }
        return present;
    }

    // ---- motion ----------------------------------------------------------

    async _setGoal(joint, position) {
        const id = SERVO_ID[joint];
        await this.dxl.writeInt(id, ADDR.TORQUE_ENABLE, 1, 1);
        await this.dxl.writeInt(id, ADDR.GOAL_POSITION, 2, Math.max(0, Math.min(4095, position | 0)));
    }

    async _waitForReach(goals) {
        const margin = this.cfg.POSITION_ERROR_MARGIN;
        const deadline = Date.now() + this.cfg.MOVE_TIMEOUT_MS;
        const joints = Object.keys(goals);
        for (;;) {
            this._checkAbort();
            let done = true;
            for (const j of joints) {
                let pos;
                try {
                    pos = await this.readPosition(j);
                } catch {
                    pos = null;
                }
                if (pos == null || Math.abs(pos - goals[j]) > margin) {
                    done = false;
                    break;
                }
            }
            if (done) return;
            if (Date.now() > deadline) {
                this.log('[move] timeout waiting for servos to reach target');
                return;
            }
            await sleep(60);
        }
    }

    /** Move a set of joints directly (no safe-height protection). */
    async moveUnsafe(targets, { wait = true } = {}) {
        this._checkAbort();
        const goals = {};
        for (const j of ALL_JOINTS) {
            if (targets[j] != null) {
                await this._setGoal(j, targets[j]);
                goals[j] = Math.max(0, Math.min(4095, targets[j] | 0));
            }
        }
        if (wait && Object.keys(goals).length) await this._waitForReach(goals);
    }

    /**
     * Move servos, raising the linear axis to a safe height first if a lateral
     * move could otherwise drag the pipette through the holder (mirrors
     * robot.py move_servos). Linear position grows downward.
     */
    async moveServos(targets, { wait = true } = {}) {
        const { shoulder, elbow, wrist, linear, thumb, gripper } = targets;
        const movingXY = shoulder != null || elbow != null || wrist != null;

        let curLinear = null;
        try {
            curLinear = await this.readPosition('linear');
        } catch {
            curLinear = null;
        }
        if (linear != null && movingXY && curLinear != null && curLinear > this.cfg.SAFE_HEIGHT) {
            await this.moveUnsafe({ linear: Math.min(this.cfg.SAFE_HEIGHT, linear) }, { wait });
        }
        await this.moveUnsafe({ shoulder, elbow, wrist, thumb, gripper }, { wait });
        if (linear != null) await this.moveUnsafe({ linear }, { wait });
    }

    /** Convenience: move only the four arm joints. */
    async moveArm({ shoulder, elbow, wrist, linear } = {}, opts) {
        await this.moveServos({ shoulder, elbow, wrist, linear }, opts);
    }

    // ---- gripper / thumb -------------------------------------------------

    async openGripper() {
        await this.moveUnsafe({ gripper: this.cfg.GRIPPER_OPEN_POSITION });
    }

    async closeGripper() {
        const id = SERVO_ID.gripper;
        await this.dxl.writeInt(id, ADDR.GOAL_POSITION, 2, this.cfg.GRIPPER_CLOSED_POSITION);
        await this.dxl.writeInt(id, ADDR.TORQUE_ENABLE, 1, 1);
        const deadline = Date.now() + 6000;
        for (;;) {
            this._checkAbort();
            let pos = null;
            let load = 0;
            try {
                pos = await this.readPosition('gripper');
                load = await this.dxl.readInt(id, ADDR.PRESENT_LOAD, 2);
            } catch {
                /* ignore */
            }
            // present_load bit 10 is direction; lower 10 bits are magnitude
            const mag = load & 0x3ff;
            if (pos != null && Math.abs(pos - this.cfg.GRIPPER_CLOSED_POSITION) <= this.cfg.POSITION_ERROR_MARGIN) return;
            if (mag > this.cfg.GRIPPER_CLOSED_LOAD) return;
            if (Date.now() > deadline) return;
            await sleep(40);
        }
    }

    async thumbDepressFirst() {
        await this.moveUnsafe({ thumb: this.cfg.THUMB_DEPRESS_FIRST_POSITION });
    }

    async thumbDepressSecond() {
        await this.moveUnsafe({ thumb: this.cfg.THUMB_DEPRESS_SECOND_POSITION });
    }

    async thumbNeutral() {
        await this.moveUnsafe({ thumb: this.cfg.THUMB_NEUTRAL_POSITION });
    }

    async thumbEject() {
        await this.moveUnsafe({ thumb: this.cfg.THUMB_EJECT_POSITION });
    }

    // ---- pipette ---------------------------------------------------------

    /**
     * Grab a pipette: approach above the slot at safe height, descend to the
     * grab pose, close the gripper, then lift back to safe height.
     * @param {{shoulder:number,elbow:number,wrist:number}} approach
     * @param {{shoulder:number,elbow:number,wrist:number,linear:number}} grab
     */
    async grabPipette(approach, grab) {
        await this.openGripper();
        await this.moveServos({ ...approach, linear: this.cfg.GRAB_HEIGHT });
        await this.moveServos({ ...grab });
        await this.closeGripper();
        await this.moveServos({ ...approach, linear: this.cfg.SAFE_HEIGHT });
    }

    /** Eject the tip and release the pipette at a release pose. */
    async ejectPipette(release) {
        if (release) await this.moveServos({ ...release, linear: this.cfg.SAFE_HEIGHT });
        await this.thumbEject();
        await sleep(300);
        await this.thumbNeutral();
        await this.openGripper();
    }

    // ---- LEDs (separate ASCII controller @9600) --------------------------

    async _ledWrite(ledNumber, power) {
        if (!this.ledIO) return;
        const p = Math.max(0, Math.min(255, power | 0));
        const str = `${ledNumber}${String(p).padStart(3, '0')}`;
        await this.ledIO.write(new TextEncoder().encode(str));
    }

    async ledArm(power = 255) {
        await this._ledWrite(this.cfg.ARM_LED_ID, power);
    }

    async ledBody(power = 255) {
        await this._ledWrite(this.cfg.BODY_LED_ID, power);
    }
}
