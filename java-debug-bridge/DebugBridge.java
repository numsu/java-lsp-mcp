import com.sun.jdi.*;
import com.sun.jdi.connect.*;
import com.sun.jdi.event.*;
import com.sun.jdi.request.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.regex.Pattern;
import java.util.regex.PatternSyntaxException;

class DebugBridge {
  static final Base64.Decoder DECODER = Base64.getUrlDecoder();
  static final Base64.Encoder ENCODER = Base64.getUrlEncoder().withoutPadding();
  static final Map<String, Session> SESSIONS = new ConcurrentHashMap<>();
  static final AtomicLong IDS = new AtomicLong();

  public static void main(String[] args) throws Exception {
    var reader = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8));
    ExecutorService requests = Executors.newCachedThreadPool();
    for (String line; (line = reader.readLine()) != null;) {
      String[] fields = line.split("\t", -1); if (fields.length < 2) continue;
      String id = fields[0], command = fields[1]; String[] values = new String[Math.max(0, fields.length - 2)];
      for (int i = 2; i < fields.length; i++) values[i - 2] = decode(fields[i]);
      requests.submit(() -> {
        try { reply(id, "OK", dispatch(command, values)); }
        catch (Throwable error) { reply(id, "ERR", obj("code", code(error), "message", message(error), "details", error instanceof DebugFailure failure && failure.details != null ? raw(failure.details) : null)); }
      });
    }
    requests.shutdown(); requests.awaitTermination(5, TimeUnit.SECONDS);
    for (Session session : SESSIONS.values()) session.detach();
  }

  static String dispatch(String command, String[] a) throws Exception {
    return switch (command) {
      case "targets" -> targets(get(a, 0), bool(a, 1));
      case "attach" -> attach(get(a, 0), integer(a, 1, 10000));
      case "sessions" -> sessions();
      case "breakpoints" -> session(a).breakpoints(get(a, 1), get(a, 2), integer(a, 3, 5000));
      case "threads" -> session(a).threads(bool(a, 1), get(a, 2), get(a, 3));
      case "wait" -> session(a).waitForStop(integer(a, 1, 30000));
      case "stack" -> session(a).stack(get(a, 1), longValue(a, 2), integer(a, 3, 0), integer(a, 4, 20), get(a, 5), bool(a, 6));
      case "variables" -> session(a).variables(get(a, 1), get(a, 2), get(a, 3), get(a, 4), integer(a, 5, 0), integer(a, 6, 50), bool(a, 7), integer(a, 8, 10), bool(a, 9));
      case "execute" -> session(a).execute(get(a, 1), get(a, 2), get(a, 3), integer(a, 4, 0));
      case "detach" -> detach(get(a, 0));
      case "hotswap" -> session(a).hotSwap(bool(a, 1), get(a, 2));
      default -> throw new DebugFailure("UNKNOWN_DEBUG_COMMAND", "Unknown debug command: " + command);
    };
  }

  static String targets(String query, boolean includeUnavailable) {
    List<String> values = new ArrayList<>();
    for (com.sun.tools.attach.VirtualMachineDescriptor descriptor : com.sun.tools.attach.VirtualMachine.list()) {
      long pid; try { pid = Long.parseLong(descriptor.id()); } catch (NumberFormatException ignored) { continue; }
      Optional<ProcessHandle> process = ProcessHandle.of(pid); String command = process.flatMap(p -> p.info().commandLine()).orElse("");
      Probe probe = command.contains("-agentlib:jdwp=") ? new Probe(command, true) : probeJvmArguments(pid);
      String fullCommand = (command + " " + probe.arguments).trim(); String display = descriptor.displayName().isBlank() ? fullCommand : descriptor.displayName();
      String haystack = (pid + " " + display + " " + fullCommand).toLowerCase(Locale.ROOT); if (!query.isBlank() && !haystack.contains(query.toLowerCase(Locale.ROOT))) continue;
      Jdwp jdwp = Jdwp.parse(fullCommand, probe.known); boolean attachable = jdwp.enabled && Boolean.TRUE.equals(jdwp.server); if (!includeUnavailable && !attachable) continue;
      values.add(obj("targetId", "local:" + pid, "pid", pid, "displayName", display, "command", emptyNull(fullCommand), "jdwp", raw(jdwp.json()), "attachable", jdwp.enabled ? attachable : (jdwp.known ? false : "unknown"), "unavailableReason", jdwp.enabled && !attachable ? "JDWP target is not listening in server mode" : null));
    }
    return obj("targets", raw(array(values)));
  }

  static String attach(String targetId, int timeout) throws Exception {
    if (!targetId.matches("local:\\d+")) throw new DebugFailure("TARGET_NOT_FOUND", "Invalid local debug target: " + targetId);
    String pid = targetId.substring(6); AttachingConnector connector = Bootstrap.virtualMachineManager().attachingConnectors().stream().filter(c -> c.name().equals("com.sun.jdi.ProcessAttach")).findFirst().orElseThrow(() -> new DebugFailure("UNSUPPORTED_CAPABILITY", "This JDK has no ProcessAttach connector"));
    int connectTimeout = Math.min(timeout, 2000); long deadline = System.currentTimeMillis() + Math.min(timeout, 5000);
    Map<String, Connector.Argument> arguments = connector.defaultArguments(); arguments.get("pid").setValue(pid); Connector.Argument timeoutArg = arguments.get("timeout"); if (timeoutArg != null) timeoutArg.setValue(String.valueOf(connectTimeout));
    VirtualMachine vm;
    while (true) {
      try { vm = connector.attach(arguments); break; }
      catch (IOException e) {
        boolean rearming = e.getMessage() != null && e.getMessage().contains("Unable to determine transport endpoint");
        if (!rearming || System.currentTimeMillis() >= deadline) throw new DebugFailure("TARGET_NOT_DEBUGGABLE", e.getMessage());
        try { Thread.sleep(50); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new DebugFailure("TARGET_NOT_DEBUGGABLE", e.getMessage()); }
      }
    }
    String id = token("session"); Session session = new Session(id, targetId, Long.parseLong(pid), vm); SESSIONS.put(id, session); session.start(); return session.info();
  }

  static String sessions() { List<String> values = new ArrayList<>(); for (Session s : SESSIONS.values()) values.add(s.summary()); return obj("sessions", raw(array(values))); }
  static String detach(String id) { Session session = SESSIONS.remove(id); if (session == null) throw new DebugFailure("SESSION_NOT_FOUND", "Debug session not found"); String targetState = session.state.equals("terminated") || session.state.equals("disconnected") ? session.state : "running"; session.detach(); return obj("sessionId", id, "targetId", session.targetId, "detached", true, "targetState", targetState); }
  static Session session(String[] args) { Session value = SESSIONS.get(get(args, 0)); if (value == null) throw new DebugFailure("SESSION_NOT_FOUND", "Debug session not found"); return value; }

  static final class Session {
    final String id, targetId; final long pid; final VirtualMachine vm; final Instant attachedAt = Instant.now(); final BlockingQueue<Stop> stops = new LinkedBlockingQueue<>(); final AtomicLong stopSequence = new AtomicLong(); final CountDownLatch startupReady = new CountDownLatch(1); volatile EventSet startupSuspension; volatile String pendingAction; volatile long pendingThreadId; volatile Instant pendingSince;
    final Map<String, Value> values = new ConcurrentHashMap<>(); final List<LogicalBreakpoint> breakpoints = new CopyOnWriteArrayList<>(); volatile Stop current; volatile String state = "running"; volatile boolean closed;
    Session(String id, String targetId, long pid, VirtualMachine vm) { this.id = id; this.targetId = targetId; this.pid = pid; this.vm = vm; }
    void start() { ClassPrepareRequest request = vm.eventRequestManager().createClassPrepareRequest(); request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD); request.enable(); daemonThread("jdi-events-" + pid, this::events).start(); try { startupReady.await(1, TimeUnit.SECONDS); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); } }
    String info() { String capabilities = obj("canRedefineClasses", capability(() -> vm.canRedefineClasses()), "canPopFrames", capability(() -> vm.canPopFrames()), "canGetBytecodes", capability(() -> vm.canGetBytecodes()), "canGetSyntheticAttribute", capability(() -> vm.canGetSyntheticAttribute()), "canWatchFieldAccess", capability(() -> vm.canWatchFieldAccess()), "canWatchFieldModification", capability(() -> vm.canWatchFieldModification())); return obj("session", raw(obj("sessionId", id, "targetId", targetId, "pid", pid, "vmName", safeVmName(), "vmVersion", safeVmVersion(), "state", state, "attachedAt", attachedAt.toString(), "activeThreadId", activeThreadId(), "stopId", current == null ? null : current.id, "attachRequired", false, "capabilities", raw(capabilities)))); }
    Long activeThreadId() { try { for (ThreadReference thread : vm.allThreads()) try { if (thread.isSuspended()) return thread.uniqueID(); } catch (Exception ignored) {} } catch (Exception ignored) {} return null; }
    String safeVmName() { try { return vm.name(); } catch (Exception e) { return "unknown"; } }
    String safeVmVersion() { try { return vm.version(); } catch (Exception e) { return "unknown"; } }
    boolean capability(BooleanSupplier probe) { try { return probe.getAsBoolean(); } catch (Exception e) { return false; } }
    String summary() { return obj("sessionId", id, "targetId", targetId, "pid", pid, "displayName", safeVmName(), "state", state, "stopId", current == null ? null : current.id, "activeRequest", pendingAction == null ? null : raw(requestInfo()), "stoppedThreads", current == null || current.thread == null ? raw("[]") : raw("[" + current.thread.uniqueID() + "]")); }
    void events() { try { while (!closed) { EventSet set = vm.eventQueue().remove(); boolean hold = false; for (Event event : set) { if (event instanceof VMStartEvent start) { startupSuspension = set; current = new Stop("stop:" + stopSequence.incrementAndGet(), "startup", start.thread(), null, set, null, null); state = "stopped"; startupReady.countDown(); hold = true; } else if (event instanceof ClassPrepareEvent prepared) installPending(prepared.referenceType()); else if (event instanceof BreakpointEvent breakpoint) { clearPending(); enqueue("breakpoint", breakpoint.thread(), breakpoint.location(), set, logicalId((BreakpointRequest) breakpoint.request())); hold = true; } else if (event instanceof StepEvent step) { step.request().disable(); vm.eventRequestManager().deleteEventRequest(step.request()); clearPending(); enqueue("step", step.thread(), step.location(), set, null); hold = true; } else if (event instanceof VMDeathEvent || event instanceof VMDisconnectEvent) { clearPending(); state = event instanceof VMDeathEvent ? "terminated" : "disconnected"; closed = true; startupReady.countDown(); stops.offer(Stop.terminal(state)); hold = true; } } if (!hold) { startupReady.countDown(); set.resume(); } } } catch (InterruptedException ignored) { Thread.currentThread().interrupt(); } catch (VMDisconnectedException ignored) { clearPending(); startupReady.countDown(); state = "disconnected"; stops.offer(Stop.terminal(state)); } }
    synchronized void enqueue(String reason, ThreadReference thread, Location location, EventSet set, String breakpointId) { String stopId = "stop:" + stopSequence.incrementAndGet(); current = new Stop(stopId, reason, thread, location, set, breakpointId, null); values.clear(); state = "stopped"; stops.offer(current); }
    String waitForStop(int timeout) throws InterruptedException { Stop stop = stops.poll(timeout, TimeUnit.MILLISECONDS); if (stop == null) return context(obj("outcome", "timeout", "state", state, "stopId", current == null ? null : current.id, "activeRequest", pendingAction == null ? null : raw(requestInfo()))); if (stop.terminal != null) return context(obj("outcome", stop.terminal, "state", state, "stopId", current == null ? null : current.id)); return context(stop.json()); }
    String execute(String action, String threadText, String stopId, int wait) throws Exception {
      Stop stop; EventSet startup = null;
      synchronized (this) {
        if (pendingAction != null) throw new DebugFailure(action.startsWith("step") ? "STEP_REQUEST_PENDING" : "EXECUTION_REQUEST_PENDING", action.startsWith("step") ? "step request already pending" : "continue request already pending");
        stop = stopId.isBlank() && action.equals("continue") ? current : requireStop(stopId);
        if (stop == null && action.equals("continue") && startupSuspension != null) {
          startup = startupSuspension; startupSuspension = null; state = "running"; pendingAction = action; pendingThreadId = 0; pendingSince = Instant.now();
        } else {
          if (stop == null) throw new DebugFailure("INVALID_STATE", "Target VM is not stopped");
          if (!action.equals("continue")) {
            long threadId = Long.parseLong(threadText); if (threadId != stop.thread.uniqueID()) throw new DebugFailure("THREAD_NOT_SUSPENDED", "Stepping requires the thread from the current stop");
            int depth = switch (action) { case "step_over" -> StepRequest.STEP_OVER; case "step_into" -> StepRequest.STEP_INTO; case "step_out" -> StepRequest.STEP_OUT; default -> throw new DebugFailure("INVALID_STATE", "Unknown execution action: " + action); };
            StepRequest request = vm.eventRequestManager().createStepRequest(stop.thread, StepRequest.STEP_LINE, depth); request.addCountFilter(1); request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD); request.enable(); pendingAction = action; pendingThreadId = threadId; pendingSince = Instant.now();
          }
          current = null; values.clear(); state = "running"; if (action.equals("continue")) { pendingAction = action; pendingThreadId = 0; pendingSince = Instant.now(); }
        }
      }
      try { if (startup != null) startup.resume(); else stop.set.resume(); } catch (Throwable error) { clearPending(); throw error; }
      if (wait > 0) return waitForStop(wait); return context(obj("outcome", "running", "activeRequest", pendingAction == null ? null : raw(requestInfo())));
    }
    synchronized String breakpoints(String sourcePath, String linesText, int timeout) throws InterruptedException {
      for (LogicalBreakpoint bp : breakpoints) if (bp.source.equals(sourcePath)) bp.delete(vm);
      breakpoints.removeIf(bp -> bp.source.equals(sourcePath)); List<String> result = new ArrayList<>();
      if (!linesText.isBlank()) for (String text : linesText.split(",")) { LogicalBreakpoint bp = new LogicalBreakpoint(token("bp"), sourcePath, Integer.parseInt(text)); breakpoints.add(bp); bp.install(vm, null); result.add(bp.json()); }
      long deadline = System.currentTimeMillis() + timeout;
      while (System.currentTimeMillis() < deadline && breakpoints.stream().filter(bp -> bp.source.equals(sourcePath)).anyMatch(bp -> bp.requests.isEmpty())) { Thread.sleep(25); }
      return obj("sourcePath", sourcePath, "breakpoints", raw(array(result)));
    }
    void installPending(ReferenceType type) { for (LogicalBreakpoint bp : breakpoints) if (bp.requests.isEmpty()) bp.install(vm, type); }
    String logicalId(BreakpointRequest request) { for (LogicalBreakpoint bp : breakpoints) if (bp.requests.contains(request)) return bp.id; return null; }
    String threads(boolean includeSystem, String packagePrefix, String namePattern) { Pattern pattern; try { pattern = namePattern.isBlank() ? null : Pattern.compile(namePattern); } catch (PatternSyntaxException e) { throw new DebugFailure("INVALID_PATTERN", "Invalid thread name pattern: " + namePattern); } List<String> result = new ArrayList<>(); for (ThreadReference thread : vm.allThreads()) { String name = thread.name(); if (!includeSystem && isSystemThread(name)) continue; if (pattern != null && !pattern.matcher(name).matches()) continue; Location location = null; String className = ""; try { if (thread.isSuspended() && !thread.frames().isEmpty()) { location = thread.frame(0).location(); className = location.declaringType().name(); } } catch (Exception ignored) {} if (!packagePrefix.isBlank() && !className.isBlank() && !className.startsWith(packagePrefix)) continue; result.add(obj("threadId", thread.uniqueID(), "name", name, "status", threadStatus(thread.status()), "suspended", thread.isSuspended(), "location", location == null ? null : raw(location(location)))); } return context(obj("threads", raw(array(result)))); }
    String stack(String stopId, long threadId, int start, int max, String packagePrefix, boolean includeInfrastructure) throws Exception { Stop stop = requireStop(stopId); if (stop.thread.uniqueID() != threadId) throw new DebugFailure("THREAD_NOT_SUSPENDED", "Thread is not the current stopped thread"); List<StackFrame> frames = stop.thread.frames(); List<Integer> selected = new ArrayList<>(); for (int i = 0; i < frames.size(); i++) { String name = frames.get(i).location().declaringType().name(); if ((includeInfrastructure || !isInfrastructure(name)) && (packagePrefix.isBlank() || name.startsWith(packagePrefix))) selected.add(i); } List<String> result = new ArrayList<>(); for (int i = start; i < Math.min(selected.size(), start + max); i++) { int original = selected.get(i); Location l = frames.get(original).location(); result.add(obj("frameId", stopId + ":" + threadId + ":" + original, "index", i, "className", l.declaringType().name(), "methodName", l.method().name(), "methodSignature", l.method().signature(), "sourcePath", source(l), "line", positive(l.lineNumber()), "native", l.method().isNative())); } return context(obj("stopId", stopId, "totalFrames", selected.size(), "frames", raw(array(result)), "truncated", start + max < selected.size(), "nextStartFrame", start + max < selected.size() ? start + max : null)); }
    String variables(String stopId, String frameId, String valueId, String scope, int start, int limit, boolean inlineFields, int maxInlineFields, boolean includeGetters) throws Exception {
      Stop stop = requireStop(stopId); List<NamedValue> found = new ArrayList<>();
      if (!valueId.isBlank()) { Value value = values.get(valueId); if (value == null) throw new DebugFailure("FRAME_NOT_FOUND", "Value reference is stale or unknown"); children(value, found); }
      else { int index = frameIndex(frameId, stopId); StackFrame frame = stop.thread.frame(index); if (scope.isBlank() || scope.equals("all") || scope.equals("this")) { ObjectReference self = frame.thisObject(); if (self != null) found.add(new NamedValue("this", self.type().name(), self)); } if (scope.isBlank() || scope.equals("all") || scope.equals("arguments") || scope.equals("locals")) try { for (LocalVariable variable : frame.visibleVariables()) { if (scope.equals("arguments") && !variable.isArgument()) continue; if (scope.equals("locals") && variable.isArgument()) continue; found.add(new NamedValue(variable.name(), variable.typeName(), frame.getValue(variable))); } } catch (AbsentInformationException e) { throw new DebugFailure("DEBUG_INFO_UNAVAILABLE", "Local variable debug information is unavailable; compile with debug information"); } }
      List<String> result = new ArrayList<>(); for (int i = start; i < Math.min(found.size(), start + limit); i++) result.add(variable(found.get(i), inlineFields, maxInlineFields, includeGetters, stop.thread));
      return context(obj("stopId", stopId, "variables", raw(array(result)), "total", found.size(), "truncated", start + limit < found.size(), "nextStart", start + limit < found.size() ? start + limit : null));
    }
    void children(Value value, List<NamedValue> out) { if (value instanceof ArrayReference array) { List<Value> items = array.getValues(); for (int i = 0; i < items.size(); i++) out.add(new NamedValue("[" + i + "]", ((ArrayType) array.type()).componentTypeName(), items.get(i))); } else if (value instanceof ObjectReference object) for (Field field : object.referenceType().allFields()) out.add(new NamedValue(field.name(), field.typeName(), object.getValue(field))); else throw new DebugFailure("INVALID_STATE", "Primitive values have no children"); }
    String variable(NamedValue named, boolean inlineFields, int maxInlineFields, boolean includeGetters, ThreadReference thread) { Value value = named.value; String kind; Integer children = null; String fields = null; if (value == null) kind = "null"; else if (value instanceof StringReference) kind = "string"; else if (value instanceof ArrayReference a) { kind = "array"; children = a.length(); } else if (value instanceof ObjectReference o) { kind = "object"; children = o.referenceType().allFields().size(); if (inlineFields || includeGetters) { List<String> inline = new ArrayList<>(); if (inlineFields) for (Field field : o.referenceType().allFields()) { if (inline.size() >= maxInlineFields) break; inline.add(variable(new NamedValue(field.name(), field.typeName(), o.getValue(field)), false, 0, false, thread)); } if (includeGetters) for (Method method : o.referenceType().methods()) { if (inline.size() >= maxInlineFields || !method.isPublic() || !method.argumentTypeNames().isEmpty() || method.isStatic() || !(method.name().startsWith("get") || method.name().startsWith("is")) || method.name().equals("getClass")) continue; try { Value getter = o.invokeMethod(thread, method, List.of(), ObjectReference.INVOKE_SINGLE_THREADED); inline.add(variable(new NamedValue(method.name() + "()", method.returnTypeName(), getter), false, 0, false, thread)); } catch (Exception ignored) {} } fields = array(inline); } } else kind = "primitive"; String valueId = children == null ? null : token("value"); if (valueId != null) values.put(valueId, value); return obj("name", named.name, "declaredType", named.type, "runtimeType", value == null ? null : value.type().name(), "value", display(value), "kind", kind, "valueId", valueId, "childCount", children, "fields", fields == null ? null : raw(fields), "lazy", children != null && !inlineFields && !includeGetters, "gettersEvaluated", includeGetters); }
    synchronized String hotSwap(boolean dryRun, String pathsText) throws Exception {
      if (!vm.canRedefineClasses()) throw new DebugFailure("UNSUPPORTED_CAPABILITY", "Target VM does not support class redefinition"); Map<ReferenceType, byte[]> definitions = new LinkedHashMap<>(); List<String> classes = new ArrayList<>();
      for (String path : pathsText.split("\\n")) { if (path.isBlank()) continue; byte[] bytes = Files.readAllBytes(Path.of(path)); String name = className(bytes); List<ReferenceType> loaded = vm.classesByName(name); if (loaded.isEmpty()) { classes.add(obj("className", name, "sourcePath", path, "status", "not_loaded", "changeType", "method_body")); continue; } for (ReferenceType type : loaded) definitions.put(type, bytes); classes.add(obj("className", name, "sourcePath", path, "status", dryRun ? "validated" : "applied", "changeType", "method_body")); }
      if (definitions.isEmpty()) return obj("outcome", "no_changes", "classes", raw(array(classes)), "diagnostics", raw("[]"), "breakpoints", raw(obj("restored", raw("[]"), "pending", raw("[]"), "rejected", raw("[]"))), "activeFrames", raw("[]"));
      String redefineError = null;
      if (!dryRun) { for (LogicalBreakpoint bp : breakpoints) bp.delete(vm); try { vm.redefineClasses(definitions); } catch (Throwable error) { redefineError = message(error); } finally { for (LogicalBreakpoint bp : breakpoints) bp.install(vm, null); } }
      List<String> restored = new ArrayList<>(), pending = new ArrayList<>(); for (LogicalBreakpoint bp : breakpoints) (bp.requests.isEmpty() ? pending : restored).add(quote(bp.id));
      if (redefineError != null) { List<String> failed = classes.stream().map(value -> value.replace("\"status\":\"applied\"", "\"status\":\"redefine_error\"").replace("\"changeType\":\"method_body\"", "\"changeType\":\"structural\"")).toList(); return obj("outcome", "redefine_failed", "classes", raw(array(failed)), "diagnostics", raw("[" + obj("severity", "error", "message", redefineError) + "]"), "breakpoints", raw(obj("restored", raw("[" + String.join(",", restored) + "]"), "pending", raw("[" + String.join(",", pending) + "]"), "rejected", raw("[]"))), "activeFrames", raw(array(obsoleteFrames()))); }
      return obj("outcome", dryRun ? "validated" : "applied", "classes", raw(array(classes)), "diagnostics", raw("[]"), "breakpoints", raw(obj("restored", raw("[" + String.join(",", restored) + "]"), "pending", raw("[" + String.join(",", pending) + "]"), "rejected", raw("[]"))), "activeFrames", raw(array(obsoleteFrames())));
    }
    List<String> obsoleteFrames() { List<String> result = new ArrayList<>(); for (ThreadReference thread : vm.allThreads()) try { if (!thread.isSuspended()) continue; for (StackFrame frame : thread.frames()) { Method method = frame.location().method(); boolean obsolete = method.isObsolete(); result.add(obj("threadId", thread.uniqueID(), "className", method.declaringType().name(), "methodName", method.name(), "obsolete", obsolete, "impact", obsolete ? "obsolete" : "continues_old_bytecode")); } } catch (IncompatibleThreadStateException | VMDisconnectedException ignored) {} return result; }
    Stop requireStop(String id) { Stop stop = current; if (stop == null) throw new DebugFailure("INVALID_STATE", "Target VM is not stopped"); if (id.isBlank() || !stop.id.equals(id)) throw new DebugFailure("STALE_STOP", "stopId '" + id + "' is stale; current stopId is '" + stop.id + "', JVM state is '" + state + "', current location is " + (stop.location == null ? "unknown" : location(stop.location)) + ". Call java_debug_sessions or java_debug_wait_for_stop to obtain a new stopId", obj("requestedStopId", id, "currentStopId", stop.id, "state", state, "location", stop.location == null ? null : raw(location(stop.location)), "hint", "Call java_debug_sessions or java_debug_wait_for_stop to obtain a new stopId")); return stop; }
    void clearPending() { pendingAction = null; pendingThreadId = 0; pendingSince = null; }
    String requestInfo() { return obj("action", pendingAction, "threadId", pendingThreadId == 0 ? null : pendingThreadId, "startedAt", pendingSince == null ? null : pendingSince.toString()); }
    String context(String payload) { String prefix = quote("sessionId") + ":" + quote(id) + "," + quote("targetId") + ":" + quote(targetId); if (!payload.contains("\"state\"")) prefix += "," + quote("state") + ":" + quote(state); return "{" + prefix + (payload.length() > 2 ? "," + payload.substring(1) : payload.substring(1)); }
    void detach() { closed = true; Stop stop = current; current = null; EventSet startup = startupSuspension; startupSuspension = null; try { if (stop != null) stop.set.resume(); if (startup != null) startup.resume(); vm.dispose(); } catch (Exception ignored) {} state = "disconnected"; }
  }

  static final class LogicalBreakpoint { final String id, source; final int line; final List<BreakpointRequest> requests = new CopyOnWriteArrayList<>(); String message;
    LogicalBreakpoint(String id, String source, int line) { this.id = id; this.source = source.replace('\\', '/'); this.line = line; }
    void install(VirtualMachine vm, ReferenceType only) { Collection<ReferenceType> types = only == null ? vm.allClasses() : List.of(only); for (ReferenceType type : types) try { boolean matches = type.sourcePaths(null).stream().anyMatch(path -> source.endsWith(path.replace('\\', '/'))); if (!matches) continue; for (Location location : type.locationsOfLine(line)) { BreakpointRequest request = vm.eventRequestManager().createBreakpointRequest(location); request.setSuspendPolicy(EventRequest.SUSPEND_EVENT_THREAD); request.enable(); requests.add(request); } } catch (AbsentInformationException ignored) {} if (requests.isEmpty()) message = "Class is not loaded or the line has no executable location"; }
    void delete(VirtualMachine vm) { for (BreakpointRequest request : requests) try { vm.eventRequestManager().deleteEventRequest(request); } catch (Exception ignored) {} requests.clear(); }
    String json() { return obj("breakpointId", id, "requestedLine", line, "resolvedLine", requests.isEmpty() ? null : line, "state", requests.isEmpty() ? "pending" : "verified", "message", requests.isEmpty() ? message : null); }
  }
  record Stop(String id, String reason, ThreadReference thread, Location location, EventSet set, String breakpointId, String terminal) { static Stop terminal(String state) { return new Stop("", "", null, null, null, null, state); } String json() { return obj("outcome", "stopped", "stopId", id, "reason", reason, "threadId", thread.uniqueID(), "location", raw(DebugBridge.location(location)), "breakpointId", breakpointId); } }
  record NamedValue(String name, String type, Value value) {}
  record Raw(String value) {}
  record Probe(String arguments, boolean known) {}
  static Probe probeJvmArguments(long pid) {
    AtomicReference<Probe> result = new AtomicReference<>(new Probe("", false));
    Thread probe = daemonThread("attach-probe-" + pid, () -> {
      com.sun.tools.attach.VirtualMachine attached = null;
      try { attached = com.sun.tools.attach.VirtualMachine.attach(String.valueOf(pid)); Properties properties = attached.getAgentProperties(); result.set(new Probe(properties.getProperty("sun.jvm.args", ""), true)); }
      catch (Throwable ignored) { }
      finally { if (attached != null) try { attached.detach(); } catch (IOException ignored) {} }
    });
    try { probe.join(750); } catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
    if (probe.isAlive()) probe.interrupt();
    Probe attachedProbe = result.get();
    if (attachedProbe.known && !attachedProbe.arguments.isBlank()) return attachedProbe;
    Probe jcmdProbe = probeWithJcmd(pid);
    return jcmdProbe.known ? jcmdProbe : attachedProbe;
  }
  static Probe probeWithJcmd(long pid) {
    Path jcmd = Path.of(System.getProperty("java.home"), "bin", System.getProperty("os.name", "").toLowerCase(Locale.ROOT).contains("win") ? "jcmd.exe" : "jcmd");
    if (!Files.exists(jcmd)) return new Probe("", false);
    try {
      Process process = new ProcessBuilder(jcmd.toString(), String.valueOf(pid), "VM.command_line").redirectErrorStream(true).start();
      if (!process.waitFor(1200, TimeUnit.MILLISECONDS)) { process.destroyForcibly(); return new Probe("", false); }
      String output = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
      for (String line : output.split("\\R")) if (line.startsWith("jvm_args:")) return new Probe(line.substring("jvm_args:".length()).trim(), true);
    } catch (Exception ignored) { }
    return new Probe("", false);
  }
  record Jdwp(boolean enabled, boolean known, String transport, Boolean server, Boolean suspend, String address) { static Jdwp parse(String command, boolean known) { int at = command.indexOf("-agentlib:jdwp="); if (at < 0) return new Jdwp(false, known, null, null, null, null); String options = command.substring(at + 15).split("\\s", 2)[0]; Map<String,String> map = new HashMap<>(); for (String item : options.split(",")) { String[] pair = item.split("=", 2); if (pair.length == 2) map.put(pair[0], pair[1]); } return new Jdwp(true, true, map.get("transport"), yes(map.get("server")), yes(map.get("suspend")), map.get("address")); } String json() { return obj("status", enabled ? "enabled" : known ? "not_enabled" : "unknown", "transport", transport, "server", server, "suspend", suspend, "address", address); } static Boolean yes(String value) { return value == null ? null : value.equalsIgnoreCase("y"); } }
  static final class DebugFailure extends RuntimeException { final String code; final String details; DebugFailure(String code, String message) { this(code, message, null); } DebugFailure(String code, String message, String details) { super(message); this.code = code; this.details = details; } }

  static String className(byte[] bytes) throws IOException { try (DataInputStream in = new DataInputStream(new ByteArrayInputStream(bytes))) { if (in.readInt() != 0xCAFEBABE) throw new IOException("Invalid class file"); in.readUnsignedShort(); in.readUnsignedShort(); int count = in.readUnsignedShort(); Object[] pool = new Object[count]; for (int i=1;i<count;i++) { int tag=in.readUnsignedByte(); switch(tag) { case 1 -> pool[i]=in.readUTF(); case 3,4 -> in.readInt(); case 5,6 -> { in.readLong(); i++; } case 7,8,16,19,20 -> pool[i]=in.readUnsignedShort(); case 9,10,11,12,17,18 -> { in.readUnsignedShort(); in.readUnsignedShort(); } case 15 -> { in.readUnsignedByte(); in.readUnsignedShort(); } default -> throw new IOException("Unknown class constant tag " + tag); } } in.readUnsignedShort(); int thisClass=in.readUnsignedShort(); return ((String)pool[(Integer)pool[thisClass]]).replace('/', '.'); } }
  static String location(Location l) { return obj("className", l.declaringType().name(), "methodName", l.method().name(), "sourcePath", source(l), "line", positive(l.lineNumber())); }
  static String source(Location l) { try { return l.sourcePath(); } catch (AbsentInformationException e) { return null; } }
  static Integer positive(int value) { return value > 0 ? value : null; }
  static int frameIndex(String id, String stop) { if (!id.startsWith(stop + ":")) throw new DebugFailure("FRAME_NOT_FOUND", "Frame reference is stale or invalid"); try { return Integer.parseInt(id.substring(id.lastIndexOf(':') + 1)); } catch (Exception e) { throw new DebugFailure("FRAME_NOT_FOUND", "Frame reference is invalid"); } }
  static boolean isSystemThread(String n) { return n.equals("Reference Handler") || n.equals("Finalizer") || n.equals("Signal Dispatcher") || n.equals("Notification Thread") || n.startsWith("Common-Cleaner"); }
  static boolean isInfrastructure(String name) { return name.startsWith("java.") || name.startsWith("javax.") || name.startsWith("jdk.") || name.startsWith("sun.") || name.startsWith("com.sun.") || name.startsWith("org.junit.") || name.startsWith("org.opentest4j.") || name.startsWith("org.apiguardian."); }
  static String threadStatus(int s) { return switch(s) { case ThreadReference.THREAD_STATUS_MONITOR -> "monitor"; case ThreadReference.THREAD_STATUS_NOT_STARTED -> "not_started"; case ThreadReference.THREAD_STATUS_RUNNING -> "running"; case ThreadReference.THREAD_STATUS_SLEEPING -> "sleeping"; case ThreadReference.THREAD_STATUS_WAIT -> "waiting"; case ThreadReference.THREAD_STATUS_ZOMBIE -> "zombie"; default -> "unknown"; }; }
  static String display(Value v) { if (v == null) return "null"; if (v instanceof StringReference s) { String x=s.value(); return x.length()>1000 ? x.substring(0,1000)+"…" : x; } if (v instanceof PrimitiveValue) return v.toString(); if (v instanceof ArrayReference a) return a.type().name()+"["+a.length()+"]"; if (v instanceof ObjectReference o) return o.referenceType().name()+"@"+Long.toHexString(o.uniqueID()); return v.toString(); }
  static String code(Throwable e) { if (e instanceof DebugFailure d) return d.code; if (e instanceof VMDisconnectedException) return "SESSION_DISCONNECTED"; if (e instanceof UnsupportedOperationException) return "UNSUPPORTED_CAPABILITY"; if (e instanceof ClassFormatError || e instanceof VerifyError || e instanceof UnsupportedClassVersionError) return "REDEFINE_FAILED"; return "DEBUG_ERROR"; }
  static String message(Throwable e) { return e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage(); }
  static Thread daemonThread(String name, Runnable task) { Thread thread = new Thread(task, name); thread.setDaemon(true); return thread; }
  static synchronized void reply(String id, String status, String json) { System.out.println(id + "\t" + status + "\t" + ENCODER.encodeToString(json.getBytes(StandardCharsets.UTF_8))); System.out.flush(); }
  static String decode(String text) { return new String(DECODER.decode(text), StandardCharsets.UTF_8); }
  static String token(String prefix) { return prefix + ":" + Long.toUnsignedString(IDS.incrementAndGet(), 36); }
  static String get(String[] a, int i) { return i < a.length ? a[i] : ""; }
  static boolean bool(String[] a, int i) { return Boolean.parseBoolean(get(a, i)); }
  static int integer(String[] a, int i, int fallback) { try { return get(a,i).isBlank()?fallback:Integer.parseInt(get(a,i)); } catch(Exception e){return fallback;} }
  static long longValue(String[] a, int i) { return Long.parseLong(get(a,i)); }
  static Object emptyNull(String value) { return value == null || value.isBlank() ? null : value; }
  static Raw raw(String value) { return new Raw(value); }
  static String array(Collection<String> values) { return "[" + String.join(",", values) + "]"; }
  static String obj(Object... pairs) { StringBuilder b=new StringBuilder("{"); boolean first=true; for(int i=0;i<pairs.length;i+=2){ if(pairs[i+1]==null)continue; if(!first)b.append(','); first=false; b.append(quote(String.valueOf(pairs[i]))).append(':').append(json(pairs[i+1])); } return b.append('}').toString(); }
  static String json(Object value) { if(value==null)return "null"; if(value instanceof Raw r)return r.value; if(value instanceof String s)return quote(s); if(value instanceof Number || value instanceof Boolean)return value.toString(); return quote(String.valueOf(value)); }
  static String quote(String s) { StringBuilder b=new StringBuilder("\""); for(char c:s.toCharArray()) switch(c){case '\"'->b.append("\\\"");case '\\'->b.append("\\\\");case '\n'->b.append("\\n");case '\r'->b.append("\\r");case '\t'->b.append("\\t");default->{if(c<32)b.append(String.format("\\u%04x",(int)c));else b.append(c);}} return b.append('\"').toString(); }
}
