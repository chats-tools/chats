#!/bin/sh
# privacy-check.sh - look for private material before this repo goes public.
#
#   scripts/privacy-check.sh                  check files + all local commits
#   scripts/privacy-check.sh --range <args>   check files + only the commits
#                                             that `git rev-list <args>` lists
#                                             (the pre-push hook uses this)
#
# Checks (a) content of every file git would publish (tracked, plus untracked
# and not ignored; text only), (b) every file name and path, (c) commit
# messages and author/committer names and emails, and the lines and file names
# each commit added or touched (so a word deleted later is still found).
# Looks for: each line of .privacy-words (plain text, case ignored), Hebrew
# letters, the built-in Drive folder word, chat/session ids, and any email
# address outside a small allow-list.
# Output: one line per hit, path:line: kind. Matched personal words are never
# printed (a file name that contains one is shown with that part masked).
# Exit: 0 clean, 1 hits found, 2 usage or git error.
#
# This file holds nothing private: sensitive literals are built from parts.
exec perl -CSD -x "$0" "$@"
#!perl
use strict;
use warnings;
use feature 'unicode_strings';
use Encode ();
use Cwd ();
use File::Basename ();

# ---------------------------------------------------------------- arguments
my @range;
if (@ARGV) {
    if ($ARGV[0] eq '--range' && @ARGV > 1) {
        @range = @ARGV[1 .. $#ARGV];
    } else {
        print STDERR "usage: privacy-check.sh [--range <rev-list args>]\n";
        exit($ARGV[0] =~ /^(-h|--help)$/ ? 0 : 2);
    }
}

my $self = Cwd::abs_path($0) // $0;
my $root = File::Basename::dirname(File::Basename::dirname($self));
unless (-e "$root/.git") {
    print STDERR "privacy-check: no .git next to scripts/ (expected in $root)\n";
    exit 2;
}
chdir($root) or do { print STDERR "privacy-check: cannot enter repo\n"; exit 2 };

# ----------------------------------------------------------------- patterns
my $gd = 'Google' . 'Drive';
my $re_gd = qr/\Q$gd\E/i;
my $re_heb = qr/[\x{0590}-\x{05FF}]|\\u05[9a-fA-F][0-9a-fA-F]/;
my $re_id = qr/cse_[A-Za-z0-9]{8,}|local_[0-9a-fA-F]{8}|session_[A-Za-z0-9]{8,}/;
my $re_mail = qr/[A-Za-z0-9._%+\-]+@([A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,})(?![A-Za-z0-9\-])/;
my %mail_ok = map { $_ => 1 } ('anthropic.com', 'example.com', 'example.org',
                               'users.noreply.github.com');

my @words;    # [ line number in words file, compiled regex ]
my $re_anyword;
my $wf = "$root/.privacy-words";
if (-f $wf) {
    if (open(my $fh, '<:raw', $wf)) {
        my $n = 0;
        while (my $l = <$fh>) {
            $n++;
            $l = Encode::decode('UTF-8', $l);
            $l =~ s/^\x{FEFF}// if $n == 1;
            $l =~ s/[\r\n]+\z//;
            next if $l =~ /^\s*#/;
            $l =~ s/^\s+|\s+\z//g;
            next if $l eq '';
            push @words, [ $n, qr/\Q$l\E/i ];
        }
        close $fh;
        if (@words) {
            my $alt = join('|', map { $_->[1] } @words);
            $re_anyword = qr/$alt/;
        }
    } else {
        print STDERR "WARNING: .privacy-words exists but cannot be read; only built-in checks ran.\n";
    }
} else {
    print STDERR "WARNING: .privacy-words not found; only built-in checks ran (no personal words).\n";
}

# Returns the list of kinds found in a piece of text (each kind once).
sub scan {
    my ($t) = @_;
    my @k;
    if ($re_anyword && $t =~ $re_anyword) {
        for my $w (@words) {
            push @k, "personal word #$w->[0]" if $t =~ $w->[1];
        }
    }
    { (my $h = $t) =~ s{\\u0590|\\u05ff}{}gi; push @k, 'Hebrew text' if $h =~ $re_heb; } # the range edges in code are allowed
    push @k, $gd                  if $t =~ $re_gd;
    push @k, 'chat or session id'  if $t =~ $re_id;
    while ($t =~ /$re_mail/g) {
        my $d = lc $1;
        next if $mail_ok{$d};
        next if $d =~ /^\d+(?:\.\d+)?x\./;    # image names such as name@2x.png
        push @k, 'email address';
        last;
    }
    return @k;
}

# Path for display: personal words masked.
sub shown {
    my ($p) = @_;
    for my $w (@words) {
        my $label = "[word #$w->[0]]";
        $p =~ s/$w->[1]/$label/g;
    }
    return $p;
}

my ($nhits, $nfiles, $nbinary, $ncommits) = (0, 0, 0, 0);
sub hit { print join('', @_), "\n"; $nhits++; }

# ------------------------------------------------------ (a) + (b) files
{
    open(my $ls, '-|', 'git', 'ls-files', '-co', '--exclude-standard', '-z')
        or do { print STDERR "privacy-check: cannot run git ls-files\n"; exit 2 };
    binmode($ls, ':raw');
    local $/ = "\0";
    my (%seen, @files);
    while (my $f = <$ls>) {
        chomp $f;
        next if $f eq '' || $seen{$f}++;
        push @files, $f;
    }
    unless (close($ls)) { print STDERR "privacy-check: git ls-files failed\n"; exit 2 }

    for my $raw (@files) {
        my $disp = Encode::decode('UTF-8', $raw);
        my $shown = shown($disp);

        my @nk = scan($disp);
        hit("$shown: file name [", join(', ', @nk), "]") if @nk;

        if (-l $raw) {
            my $target = Encode::decode('UTF-8', readlink($raw) // '');
            $nfiles++;
            hit("$shown:1: $_") for scan($target);
            next;
        }
        next unless -f $raw;    # deleted-but-tracked files, nested repos
        open(my $fh, '<:raw', $raw) or do {
            print STDERR "privacy-check: cannot read $shown\n";
            exit 2;
        };
        my $head = '';
        read($fh, $head, 8000);
        if (index($head, "\0") >= 0) { $nbinary++; close $fh; next }
        seek($fh, 0, 0);
        $nfiles++;
        local $/ = "\n";
        my $ln = 0;
        while (my $line = <$fh>) {
            $ln++;
            $line = Encode::decode('UTF-8', $line);
            hit("$shown:$ln: $_") for scan($line);
        }
        close $fh;
    }
}

# ------------------------------------------------------------ (c) commits
{
    my @revargs = @range ? @range : ('--branches');
    open(my $rl, '-|', 'git', 'rev-list', @revargs) or do {
        print STDERR "privacy-check: cannot run git rev-list\n";
        exit 2;
    };
    my @shas = map { chomp; $_ } <$rl>;
    unless (close($rl)) {
        print STDERR "privacy-check: git rev-list failed for the given range\n";
        exit 2;
    }
    for my $sha (@shas) {
        next unless $sha =~ /^[0-9a-f]{7,64}$/;
        $ncommits++;
        my $short = substr($sha, 0, 7);
        open(my $c, '-|', 'git', 'log', '-1', '--format=%an%x00%ae%x00%cn%x00%ce%x00%B', $sha)
            or do { print STDERR "privacy-check: cannot run git log\n"; exit 2 };
        binmode($c, ':raw');
        local $/;
        my $data = Encode::decode('UTF-8', scalar <$c>);
        close $c;
        my ($an, $ae, $cn, $ce, $msg) = split(/\0/, $data, 5);
        $msg //= '';
        my %who;
        for my $k (scan(($an // '') . "\n" . ($ae // ''))) { $who{$k} = 1 }
        hit("commit $short author: $_") for sort keys %who;
        my %cw;
        for my $k (scan(($cn // '') . "\n" . ($ce // ''))) { $cw{$k} = 1 }
        hit("commit $short committer: $_") for sort keys %cw;
        my $ln = 0;
        for my $line (split(/\n/, $msg)) {
            $ln++;
            hit("commit $short message:$ln: $_") for scan($line);
        }

        # What the commit added (a word deleted later is still in history) and the names of the
        # files it touched. Kinds are listed once per commit; the matched text is never printed.
        {
            local $/ = "\n";
            my %dk;
            open(my $d, '-|', 'git', 'show', '-m', '--no-renames', '--no-ext-diff', '--no-textconv',
                 '--format=', '--unified=0', $sha)
                or do { print STDERR "privacy-check: cannot run git show\n"; exit 2 };
            binmode($d, ':raw');
            my $inhunk = 0;
            while (my $l = <$d>) {
                if ($l =~ /^diff /) { $inhunk = 0; next }
                if ($l =~ /^\@\@/) { $inhunk = 1; next }
                next unless $inhunk && $l =~ /^\+/;
                $l =~ s/^\+//;
                for my $k (scan(Encode::decode('UTF-8', $l))) { $dk{$k} = 1 }
            }
            unless (close($d)) { print STDERR "privacy-check: git show failed\n"; exit 2 }
            hit("commit $short diff: $_") for sort keys %dk;

            my %nk;
            open(my $n, '-|', 'git', 'show', '-m', '--no-renames', '--format=', '--name-only', '-z', $sha)
                or do { print STDERR "privacy-check: cannot run git show\n"; exit 2 };
            binmode($n, ':raw');
            {
                local $/ = "\0";
                while (my $f = <$n>) {
                    chomp $f;
                    next if $f eq '';
                    for my $k (scan(Encode::decode('UTF-8', $f))) { $nk{$k} = 1 }
                }
            }
            unless (close($n)) { print STDERR "privacy-check: git show failed\n"; exit 2 }
            hit("commit $short file name: $_") for sort keys %nk;
        }
    }
}

# ----------------------------------------------------------------- summary
my $what = "$nfiles text files ($nbinary binary skipped), $ncommits commits";
if ($nhits) {
    print "privacy-check: $nhits hit(s) in $what. Fix them before making the repo public.\n";
    exit 1;
}
print "privacy-check: clean ($what checked).\n";
exit 0;
