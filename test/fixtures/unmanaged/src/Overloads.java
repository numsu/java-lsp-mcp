interface Worker { String work(String value); }
sealed interface Shape permits Circle {}
record Circle(double radius) implements Shape {}

public class Overloads implements Worker {
    private int usedField;
    private int unusedField;
    public String work(String value) { return value; }
    public int work(int value) { return value + 1; }
    public String caller() { usedField = 1; return usedField + work("text"); }
    private void unusedMethod() {}
}
