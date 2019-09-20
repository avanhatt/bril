#!/usr/bin/env node
import * as bril from './bril';
import {readStdin, unreachable} from './util';

const argCounts: {[key in bril.OpCode]: number | null} = {
  add: 2,
  mul: 2,
  sub: 2,
  div: 2,
  id: 1,
  lt: 2,
  le: 2,
  gt: 2,
  ge: 2,
  eq: 2,
  not: 1,
  and: 2,
  or: 2,
  print: null,  // Any number of arguments.
  br: 3,
  jmp: 1,
  ret: null, // Should be 0 or 1
  nop: 0,
  call: null,
};

type Value = boolean | BigInt;
type ReturnValue = Value | null;
type Env = Map<bril.Ident, Value>;

/**
 * We need a correspondence between Bril's understanding of a type and the 
 * interpreter's underlying representation type 
 */
const brilTypeToDynamicType: {[key in bril.Type] : string} = {
  'int' : 'bigint',
  'bool': 'boolean',
};

function get(env: Env, ident: bril.Ident) {
  let val = env.get(ident);
  if (typeof val === 'undefined') {
    throw `undefined variable ${ident}`;
  }
  return val;
}

function findFunc(func : bril.Ident, funcs: bril.Function[]) {
  for (let f of funcs) {
    if (f.name === func) {
      return f;
    }
  }
  return null;
}

/**
 * Ensure that the instruction has exactly `count` arguments,
 * throwing an exception otherwise.
 */
function checkArgs(instr: bril.Operation, count: number) {
  if (instr.args.length != count) {
    throw `${instr.op} takes ${count} argument(s); got ${instr.args.length}`;
  }
}

function getArgument(instr: bril.Operation, env: Env, index: number, 
  typ : bril.Type) {
  let val = get(env, instr.args[index]);
  let brilTyp = brilTypeToDynamicType[typ];
  if (brilTyp !== typeof val) {
    throw `${instr.op} argument ${index} must be a {brilTyp}`;
  }
  return val;
}

function getInt(instr: bril.Operation, env: Env, index: number) : bigint {
  return getArgument(instr, env, index, 'int') as bigint;
}

function getBool(instr: bril.Operation, env: Env, index: number) : boolean {
  return getArgument(instr, env, index, 'bool') as boolean;
}

/**
 * The thing to do after interpreting an instruction: either transfer
 * control to a label, go to the next instruction, or end thefunction.
 */
type Action =
  {"label": bril.Ident} |
  {"next": true} |
  {"end": ReturnValue};
let NEXT: Action = {"next": true};
let END: Action = {"end": true};

/**
 * Interpret an instruction in a given environment, possibly updating the
 * environment. If the instruction branches to a new label, return that label;
 * otherwise, return "next" to indicate that we should proceed to the next
 * instruction or "end" to terminate the function.
 */
function evalInstr(instr: bril.Instruction, env: Env, funcs: bril.Function[]): Action {
  // Check that we have the right number of arguments.
  if (instr.op !== "const") {
    let count = argCounts[instr.op];
    if (count === undefined) {
      throw "unknown opcode " + instr.op;
    } else if (count !== null) {
      checkArgs(instr, count);
    }
  }

  switch (instr.op) {
  case "const":
    // Ensure that JSON ints get represented appropriately.
    let value: Value;
    if (typeof instr.value === "number") {
      value = BigInt(instr.value);
    } else {
      value = instr.value;
    }

    env.set(instr.dest, value);
    return NEXT;

  case "id": {
    let val = get(env, instr.args[0]);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "add": {
    let val = getInt(instr, env, 0) + getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "mul": {
    let val = getInt(instr, env, 0) * getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "sub": {
    let val = getInt(instr, env, 0) - getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "div": {
    let val = getInt(instr, env, 0) / getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "le": {
    let val = getInt(instr, env, 0) <= getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "lt": {
    let val = getInt(instr, env, 0) < getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "gt": {
    let val = getInt(instr, env, 0) > getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "ge": {
    let val = getInt(instr, env, 0) >= getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "eq": {
    let val = getInt(instr, env, 0) === getInt(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "not": {
    let val = !getBool(instr, env, 0);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "and": {
    let val = getBool(instr, env, 0) && getBool(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "or": {
    let val = getBool(instr, env, 0) || getBool(instr, env, 1);
    env.set(instr.dest, val);
    return NEXT;
  }

  case "print": {
    let values = instr.args.map(i => get(env, i).toString());
    console.log(...values);
    return NEXT;
  }

  case "jmp": {
    return {"label": instr.args[0]};
  }

  case "br": {
    let cond = getBool(instr, env, 0);
    if (cond) {
      return {"label": instr.args[1]};
    } else {
      return {"label": instr.args[2]};
    }
  }
  
  case "ret": {
    let argCount = instr.args.length;
    if (argCount == 0) {
      return {"end": null};
    } else if (argCount == 1) {
      let val = get(env, instr.args[0]);
      return {"end": val};
    } else {
      throw `ret takes 0 or 1 argument(s); got ${argCount}`;
    }
  }

  case "nop": {
    return NEXT;
  }

  case "call": {
    // check well-formedness: does function exist? arity of function matches number of args provided
    // look up function by name
    // look up arg types in function, compare to provided argument types
    // check that labeled return type matches function return type
    // create a new environment, populate with arguments

    let name = instr.name;
    let func = findFunc(name, funcs);
    if (func === null) {
      throw `undefined function ${name}`;
    }

    let newEnv: Env = new Map();

    // check arity of arguments and definition

    for (let i = 0; i < func.args.length; i++) {
      // Look up the variable in the current (calling) environment
      let value = get(env, instr.args[i]);

      // check argument types
      // if (brilTypeToDynamicType[func.args[i].type] !== typeof value) {
      //   throw `function argument type mismatch`
      // }

      // Set the value of the arg in the new (function) environemt
      newEnv.set(func.args[i].name, value);
    }

    // TODO check function return type against what's being returned
    // let retType = instr.type;
    let retVal = evalFuncInEnv(func, funcs, newEnv);
    switch (instr.ret) {
      case undefined:
        // void return type
        if (retVal !== null) {
          throw `unexpected value returned by void function`;
        }
        break;
      default:
        if (retVal === null) {
          throw `nothing returned from non-void function`
        }
        if (brilTypeToDynamicType[instr.ret.type] !== typeof retVal) {
          throw `type of value returned by function does not match declaration`;
        }
        env.set(instr.ret.dest, retVal);
        console.log(instr.ret.dest)
        console.log(env.get(instr.ret.dest))
        break;
    }
    return NEXT;
  }
  
  }
  unreachable(instr);
  throw `unhandled opcode ${(instr as any).op}`;
}

function evalFunc(func: bril.Function, funcs: bril.Function[]) {
  let newEnv: Env = new Map();
  evalFuncInEnv(func, funcs, newEnv);
}

function evalFuncInEnv(func: bril.Function, funcs: bril.Function[], env: Env) : ReturnValue {
  for (let i = 0; i < func.instrs.length; ++i) {
    let line = func.instrs[i];
    if ('op' in line) {
      let action = evalInstr(line, env, funcs);

      if ('label' in action) {
        // Search for the label and transfer control.
        for (i = 0; i < func.instrs.length; ++i) {
          let sLine = func.instrs[i];
          if ('label' in sLine && sLine.label === action.label) {
            break;
          }
        }
        if (i === func.instrs.length) {
          throw `label ${action.label} not found`;
        }
      } else if ('end' in action) {
        return action.end;
      }
    }
  }

  return null;
}

function evalProg(prog: bril.Program) {
  let main = findFunc("main", prog.functions);
  if (main === null) {
    console.log(`warning: no main function defined, doing nothing`);
  } else {
    evalFunc(main, prog.functions);
  }
}

async function main() {
  let prog = JSON.parse(await readStdin()) as bril.Program;
  evalProg(prog);
}

// Make unhandled promise rejections terminate.
process.on('unhandledRejection', e => { throw e });

main();
