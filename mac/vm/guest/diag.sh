#!/bin/bash
# Sourced by wrapper.sh: what the runner's listener has done, read from its own record, the diag logs it writes in
# <runner>/_diag/Runner_<yyyyMMdd-HHmmss>-utc.log (actions/runner v2.338.0, HostTraceListener.cs: a new file per start
# and per page, so a self-update's relaunch writes one more). Every trace is one line,
# `[<yyyy-MM-dd HH:mm:ss>Z <INFO|WARN|ERR |VERB> <source>] <message>` (WriteHeader's `[{0:u} {1} {2}] `); a line that
# does not start so (an exception's continuation) is skipped. Terminal.WriteLine traces each console line as
# `WRITE LINE: <line>`, Terminal.WriteError as `WRITE ERROR: <line>`. The messages read, by what they mean:
#
#   listening  `WRITE LINE: <time>: Listening for Jobs` (Runner.cs RunAsync, once the session is created)
#   conflict   `The session for this runner already exists.` or `WRITE ERROR: A session for this runner already
#              exists.` (MessageListener.cs and BrokerMessageListener.cs, on TaskAgentSessionConflictException; the
#              listener retries every 30 s for up to 4 min, then exits)
#   job        the listener took a job, earliest first: `Acknowledging runner request '<id>'.` (BrokerMessageListener.cs,
#              before the job is acquired, broker flow), `Received job message of length <n> …` (Runner.cs, the older
#              flow), `Job request <n> for plan <guid> job <guid> received.` (JobDispatcher.Run, both flows), `WRITE
#              LINE: <time>: Running job: <name>` (JobDispatcher.RunOnceAsync). A plain `Message '<id>' received.` is
#              any message, a refresh or a cancel as well, and is not one.
#   update     `Refresh message received, kick-off selfupdate background process.` (Runner.cs): the runner is updating
#              itself inside the clone, and will again in every clone until the image is refreshed (The image)
#
# diag_scan <diag dir> reads every Runner_*.log there, in name order (kickoff.sh empties the directory, so all of them
# are this clone's), and prints a line for each kind seen, at its first time: `listening <time>`, `conflict <time>`,
# `job <time> <id>`, `update <time>`, the time as YYYY-MM-DDTHH:MM:SSZ. A job's id is the dispatch's job GUID, else the
# acknowledged request's id, else `-`. It prints `unreadable` when the directory or a log in it cannot be read, or the
# scan itself fails: what it did not read may hold a job, and a reader must not take the silence for none.
diag_scan() { # <diag dir>
  local logs
  [[ -e $1 ]] || return 0
  if [[ ! -d $1 || ! -r $1 || ! -x $1 ]]; then
    echo unreadable
    return 0
  fi
  logs=("$1"/Runner_*.log)
  [[ -e ${logs[0]} ]] || return 0
  perl -MIO::Handle -e '
    for my $file (@ARGV) {
      # A log is a regular file read to its end: a read that fails (EISDIR, EIO) ends the loop as an end of file would,
      # so the error is read from errno and the handle after it, not from close alone.
      (-f $file && open(my $log, "<", $file)) or do { $unreadable = 1; next };
      $! = 0;
      while (<$log>) {
        next unless /^\[(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)Z [A-Z]+ +[^\]]*\] (.*?)\r?$/;
        my ($at, $m) = ("$1T$2Z", $3);
        if ($m =~ /^WRITE LINE: .*: Listening for Jobs$/) { $first{listening} //= $at }
        elsif ($m =~ /^(?:The session for this runner already exists\.|WRITE ERROR: A session for this runner already exists\.)$/) {
          $first{conflict} //= $at;
        }
        elsif ($m =~ /^Acknowledging runner request \x27([^\x27]+)\x27\.$/) { $first{job} //= $at; $request //= $1 }
        elsif ($m =~ /^Job request \d+ for plan \S+ job (\S+) received\.$/) { $first{job} //= $at; $id //= $1 }
        elsif ($m =~ /^Received job message of length \d+ / || $m =~ /^WRITE LINE: .*: Running job: /) { $first{job} //= $at }
        elsif ($m =~ /^Refresh message received, kick-off selfupdate background process\.$/) { $first{update} //= $at }
      }
      $unreadable = 1 if $! || $log->error;
      $unreadable = 1 unless close($log);
    }
    print "listening $first{listening}\n" if $first{listening};
    print "conflict $first{conflict}\n" if $first{conflict};
    print "job $first{job} ", ($id // $request // "-"), "\n" if $first{job};
    print "update $first{update}\n" if $first{update};
    print "unreadable\n" if $unreadable;
  ' "${logs[@]}" || echo unreadable
}
