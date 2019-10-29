#!/usr/bin/env node
import * as bril from './bril';
import { Heap, Key } from './heap';
import {readStdin, unreachable} from './util';

class BriliError extends Error {
    constructor(message?: string) {
        super(message);
        Object.setPrototypeOf(this, new.target.prototype);
        this.name = BriliError.name;
    }
}

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
  alloc: 1,
  free: 1,
  store: 2,
  load: 1,
  ptradd: 2
};

type Pointer = {
  loc: Key;
  type: bril.Type;
}

type Value = boolean | Pointer | BigInt;
type ReturnValue = Value | null;

type Env = Map<bril.Ident, Value>;

/**
 * We need a correspondence between Bril's understanding of a type and the 
 * interpreter's underlying representation type 
 */
const brilTypeToDynamicType: {[key in bril.Type] : string} = {
  'int' : 'bigint',
  'bool': 'boolean',
  'ptr' : 'object',

};

function get(env: Env, ident: bril.Ident) {
  let val = env.get(ident);
  if (typeof val === 'undefined') {
    throw new BriliError(`undefined variable ${ident}`);
  }
  return val;
}

function findFunc(func : bril.Ident, funcs: bril.Function[]) {
  let matches = funcs.filter(function (f: bril.Function) {
    return f.name === func;
  });

  if (matches.length == 0) {
    throw new BriliError(`no function of name ${func} found`);
  } else if (matches.length > 1) {
    throw new BriliError(`multiple functions of name ${func} found`);
  }

  return matches[0];
}

function alloc(ptrType: bril.PointerType, amt:number, heap:Heap<Value>): Pointer {
  if (typeof ptrType != 'object') {
    throw `unspecified pointer type ${ptrType}`
  } else if (amt <= 0) {
    throw `must allocate a positive amount of memory: ${amt} <= 0`
  } else {
    let loc = heap.alloc(amt)
    let dataType = ptrType.ptr;
    if (dataType !== "int" && dataType !== "bool") {
      dataType = "ptr";
    }
    return {
      loc: loc,
      type: dataType
    }
  }
}

/**
 * Ensure that the instruction has exactly `count` arguments,
 * throw an exception otherwise.
 */
function checkArgs(instr: bril.Operation, count: number) {
  if (instr.args.length != count) {
    throw new BriliError(`${instr.op} takes ${count} argument(s); got ${instr.args.length}`);
  }
}

function getArgument(instr: bril.Operation, env: Env, index: number, 
  typ : bril.Type) {
  let val = get(env, instr.args[index]);
  let brilTyp = brilTypeToDynamicType[typ];
  if (brilTyp !== typeof val) {
    throw new BriliError(`${instr.op} argument ${index} must be a {brilTyp}`);
  }
  return val;
}

function getInt(instr: bril.Operation, env: Env, index: number) : bigint {
  return getArgument(instr, env, index, 'int') as bigint;
}

function getBool(instr: bril.Operation, env: Env, index: number) : boolean {
  return getArgument(instr, env, index, 'bool') as boolean;
}

function getPtr(instr: bril.Operation, env: Env, index: number): Pointer {
  let val = get(env, instr.args[index]);
  if (typeof val !== 'object' || val instanceof BigInt) {
    throw `${instr.op} argument ${index} must be a Pointer`;
  }
  return val;
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
 * Interpet a call instruction.
 */
function evalCall(instr: bril.CallOperation, env: Env, funcs: bril.Function[], heap: Heap<Value>)
  : Action {
  let func = findFunc(instr.name, funcs);
  if (func === null) {
    throw new BriliError(`undefined function ${instr.name}`);
  }

  let newEnv: Env = new Map();

  // check arity of arguments and definition
  if (func.args.length !== instr.args.length) {
    throw new BriliError(`function expected ${func.args.length} arguments, got ${instr.args.length}`);
  }

  for (let i = 0; i < func.args.length; i++) {
    // Look up the variable in the current (calling) environment
    let value = get(env, instr.args[i]);

    // Check argument types
    if (brilTypeToDynamicType[func.args[i].type] !== typeof value) {
      throw new BriliError(`function argument type mismatch`);
    }

    // Set the value of the arg in the new (function) environemt
    newEnv.set(func.args[i].name, value);
  }

  let valueCall : bril.ValueCallOperation = instr as bril.ValueCallOperation;

  // Dynamically check the function's return value and type
  let retVal = evalFuncInEnv(func, funcs, newEnv, heap);
  if (valueCall.dest === undefined && valueCall.type === undefined) {
     // Expected void function
    if (retVal !== null) {
      throw new BriliError(`unexpected value returned without destination`);
    }
    if (func.type !== undefined) {
      throw new BriliError(`non-void function (type: ${func.type}) doesn't return anything`); 
    }
  } else {
    // Expected non-void function
    if (valueCall.type === undefined) {
      throw new BriliError(`function call must include a type if it has a destination`);  
    }
    if (valueCall.dest === undefined) {
      throw new BriliError(`function call must include a destination if it has a type`);  
    }
    if (retVal === null) {
      throw new BriliError(`non-void function (type: ${func.type}) doesn't return anything`);
    }
    if (brilTypeToDynamicType[valueCall.type] !== typeof retVal) {
      throw new BriliError(`type of value returned by function does not match destination type`);
    }
    if (func.type !== valueCall.type ) {
      throw new BriliError(`type of value returned by function does not match declaration`);
    }
    env.set(valueCall.dest, retVal);
  }
  return NEXT;
}

/**
 * Interpret an instruction in a given environment, possibly updating the
 * environment. If the instruction branches to a new label, return that label;
 * otherwise, return "next" to indicate that we should proceed to the next
 * instruction or "end" to terminate the function.
 */
function evalInstr(instr: bril.Instruction, env: Env, funcs: bril.Function[], heap:Heap<Value>): Action {
  // Check that we have the right number of arguments.
  if (instr.op !== "const") {
    let count = argCounts[instr.op];
    if (count === undefined) {
      throw new BriliError("unknown opcode " + instr.op);
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
      throw new BriliError(`ret takes 0 or 1 argument(s); got ${argCount}`);
    }
  }

  case "nop": {
    return NEXT;
  }

  case "call": {
    return evalCall(instr, env, funcs, heap);
  }
  
  case "alloc": {
    let amt = getInt(instr, env, 0)
    let ptr = alloc(instr.type, Number(amt), heap)
    env.set(instr.dest, ptr);
    return NEXT;
  }

  case "free": {
    let val = getPtr(instr, env, 0)
    heap.free(val.loc);
    return NEXT;
  }

  case "store": {
    let target = getPtr(instr, env, 0)
    switch (target.type) {
      case "int": {
        heap.write(target.loc, getInt(instr, env, 1))
        break;
      }
      case "bool": {
        heap.write(target.loc, getBool(instr, env, 1))
        break;
      }
      case "ptr": {
        heap.write(target.loc, getPtr(instr, env, 1))
        break;
      }
    }
    return NEXT;
  }

  case "load": {
    let ptr = getPtr(instr, env, 0)
    let val = heap.read(ptr.loc)
    if (val == undefined || val == null) {
      throw `Pointer ${instr.args[0]} points to uninitialized data`;
    } else {
      env.set(instr.dest, val)
    }
    return NEXT;
  }

  case "ptradd": {
    let ptr = getPtr(instr, env, 0)
    let val = getInt(instr, env, 1)
    env.set(instr.dest, { loc: ptr.loc.add(Number(val)), type: ptr.type })
    return NEXT;
  }

  }
  unreachable(instr);
  throw new BriliError(`unhandled opcode ${(instr as any).op}`);
}

function evalFuncInEnv(func: bril.Function, funcs: bril.Function[], env: Env, heap: Heap<Value>)
  : ReturnValue {
  for (let i = 0; i < func.instrs.length; ++i) {
    let line = func.instrs[i];
    if ('op' in line) {
      let action = evalInstr(line, env, funcs, heap);

      if ('label' in action) {
        // Search for the label and transfer control.
        for (i = 0; i < func.instrs.length; ++i) {
          let sLine = func.instrs[i];
          if ('label' in sLine && sLine.label === action.label) {
            break;
          }
        }
        if (i === func.instrs.length) {
          throw new BriliError(`label ${action.label} not found`);
        }
      } else if ('end' in action) {
        return action.end;
      }
    }
  }

  return null;
}

function parseBool(s : string) : boolean {
  if (s === 'true') {
    return true;
  } else if (s === 'false') {
    return false;
  } else {
    throw new BriliError(`boolean argument to main must be 'true'/'false'; got ${s}`);
  }
}

function parseMainArguments(expected: bril.Argument[], args: string[]) : Env {
  let newEnv: Env = new Map();

  if (args.length !== expected.length) {
    throw new BriliError(`mismatched main argument arity: expected ${expected.length}; got ${args.length}`);
  }

  for (let i = 0; i < args.length; i++) {
    let type = expected[i].type;
    switch (type) {
      case "int":
        let n : bigint = BigInt(parseInt(args[i]));
        newEnv.set(expected[i].name, n as Value);
        break;
      case "bool":
        let b : boolean = parseBool(args[i]);
        newEnv.set(expected[i].name, b as Value);
        break;
    }
  }
  return newEnv;
}

function evalProg(prog: bril.Program) {
  let main = findFunc("main", prog.functions);
  let heap = new Heap<Value>()

  if (main === null) {
    console.log(`warning: no main function defined, doing nothing`);
  } else {
    let expected = main.args;
    let args : string[] = process.argv.slice(2, process.argv.length);
    let newEnv = parseMainArguments(expected, args);
    evalFuncInEnv(main, prog.functions, newEnv, heap);
  }
  if (!heap.isEmpty()) {
    throw `Some memory locations have not been freed by end of execution.`
  }
}

async function main() {
  try {
    let prog = JSON.parse(await readStdin()) as bril.Program;
    evalProg(prog);
  }
  catch(e) {
    if(e instanceof BriliError) {
      console.error(`Brili interpreter error: ${e.message}`) 
      process.exit(2);
    } else {
      throw e;
    }
  }
}

// Make unhandled promise rejections terminate.
process.on('unhandledRejection', e => { throw e });

main();
